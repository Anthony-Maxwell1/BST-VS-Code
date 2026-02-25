import * as vscode from "vscode";
import WebSocket from "ws";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import * as os from "os";

// ------------------- WebSocket & State -------------------

let extensionPath: string;
let ws: WebSocket | undefined;
let fileProvider: FileProvider;
let propertiesPanel: PropertiesPanel;
let connected = false;
let serverReady = false;

const pendingRequests = new Map<string, (data: any) => void>();
let nextId = 1;

function generateId(): string {
  return `vsc-${nextId++}-${Date.now()}`;
}

function sendCliCommand(
  command: string,
  args?: Record<string, any>,
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error("WebSocket is not connected"));
    }
    const id = generateId();
    const payload: Record<string, any> = { type: "cli", command, id };
    if (args) {
      payload.args = args;
    }
    pendingRequests.set(id, resolve);
    ws.send(JSON.stringify(payload));

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Request "${command}" timed out`));
      }
    }, 30_000);
  });
}

function sendEdit(args: Record<string, any>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error("WebSocket is not connected"));
    }
    const id = generateId();
    const payload = { type: "edit", id, args };
    pendingRequests.set(id, resolve);
    ws.send(JSON.stringify(payload));

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("Edit request timed out"));
      }
    }, 30_000);
  });
}

function handleMessage(raw: string) {
  try {
    const msg = JSON.parse(raw);
    if (msg.type === "response" && msg.id && pendingRequests.has(msg.id)) {
      const cb = pendingRequests.get(msg.id)!;
      pendingRequests.delete(msg.id);
      cb(msg);
    }
  } catch {
    // ignore non-JSON
  }
}

// ------------------- Activation -------------------

export function activate(context: vscode.ExtensionContext) {
  fileProvider = new FileProvider();
  propertiesPanel = new PropertiesPanel();
  extensionPath = context.extensionPath;

  const fileTreeView = vscode.window.createTreeView("filePanel", {
    treeDataProvider: fileProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(fileTreeView);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("propertiesPanel", propertiesPanel),
  );

  // Handle selection changes in the file tree → update properties
  context.subscriptions.push(
    fileTreeView.onDidChangeSelection((e) => {
      if (e.selection.length > 0 && e.selection[0] instanceof FileNode) {
        propertiesPanel.update(e.selection[0]);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bst.startServer", async () => {
      serverReady = await checkWebSocketAvailable();
      if (connected || serverReady) {
        vscode.window.showInformationMessage("Server already ready");
        return;
      }
      cp.exec("bst run", (err, stdout, stderr) => {
        if (err) {
          // err is usually a ChildProcessError which has a 'code' property
          const exitCode = (err as any).code; // typecast if needed
          if (exitCode === 1) {
            vscode.window.showErrorMessage(
              "BST Core not installed. Install by running Fetch Core in the command pallete.",
            );
          } else {
            vscode.window.showErrorMessage(
              `BST Cli might not be installed. Install by running Install CLI in command pallete. Server failed with exit code ${exitCode}: ${err.message}.`,
            );
          }
        } else {
          vscode.window.showInformationMessage("Server started");
        }
      });
      serverReady = true;
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bst.installCli", async () => {
      try {
        const platform = os.platform();
        const home = os.homedir();
        let targetDir: string;
        let exeName: string;

        if (platform === "win32") {
          targetDir = path.join(home, "AppData", "Local", "bst");
          exeName = "bst-win.exe";
        } else if (platform === "darwin") {
          targetDir = path.join(home, ".bst");
          exeName = "bst-mac";
        } else {
          targetDir = path.join(home, ".bst");
          exeName = "bst-linux";
        }

        const exePath = path.join(targetDir, exeName);

        // Create directory if it doesn't exist
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        // Download binary
        const binaryUrl = `https://github.com/Anthony-Maxwell1/BST-Cli/releases/latest/download/${exeName}`;
        console.log(binaryUrl);
        const res = await fetch(binaryUrl);
        if (!res.ok) {
          throw new Error(`Failed to download: ${res.statusText}`);
        }

        const buffer = Buffer.from(await res.arrayBuffer());
        const finalExeName = platform === "win32" ? "bst.exe" : "bst";
        const finalExePath = exePath.replace(exeName, finalExeName);
        await fs.promises.writeFile(finalExePath, buffer);

        // Make it executable on Unix
        if (platform !== "win32") {
          fs.chmodSync(finalExePath, 0o755);
        }

        vscode.window.showInformationMessage(
          `bst binary installed to ${finalExePath}`,
        );

        // Add to PATH
        if (platform === "win32") {
          const addToPathCmd = `[Environment]::SetEnvironmentVariable('Path', "$([Environment]::GetEnvironmentVariable('Path', 'User'));${targetDir}", 'User')`; // TODO: FIX, SO PATH ISN'T TRUNCATED
          cp.exec(
            addToPathCmd,
            { shell: "powershell.exe" },
            (error, stdout, stderr) => {
              if (error) {
                vscode.window.showErrorMessage(
                  `Failed to update PATH: ${stderr}`,
                );
              } else {
                vscode.window.showInformationMessage(
                  `Added ${targetDir} to PATH. Restart VS Code to apply.`,
                );
              }
            },
          );
        } else {
          // Unix: add to shell profile
          const shell = process.env.SHELL || "";
          let profile = path.join(home, ".bashrc"); // default to bash
          if (shell.includes("zsh")) {
            profile = path.join(home, ".zshrc");
          }

          const exportLine = `export PATH="${targetDir}:$PATH"\n`;
          fs.appendFileSync(profile, exportLine);

          vscode.window.showInformationMessage(
            `Added ${targetDir} to PATH. Restart terminal or VS Code to apply.`,
          );
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Error installing BST binary: ${err.message}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bst.installCore", async () => {
      cp.exec("bst fetch", (err, stdout, stderr) => {
        if (err) {
          vscode.window.showErrorMessage(
            "Failed to install Core: " + err.message,
          );
        } else {
          vscode.window.showInformationMessage("Core installed");
        }
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("bst.stopServer", async () => {
      cp.exec("bst stop", (err, stdout, stderr) => {
        if (err) {
          vscode.window.showErrorMessage(
            "Failed to stop server: " + err.message,
          );
        } else {
          vscode.window.showInformationMessage("Server stopped");
        }
      });
      serverReady = false;
    }),
  );

  checkWebSocketAvailable(2000, true);

  // --- Connect ---
  context.subscriptions.push(
    vscode.commands.registerCommand("bst.connect", async () => {
      if (connected) {
        vscode.window.showInformationMessage("Already connected");
        return;
      }

      ws = new WebSocket("ws://localhost:5000");

      ws.on("open", async () => {
        connected = true;
        vscode.window.showInformationMessage(
          "Connected to Better Studio server",
        );
        vscode.commands.executeCommand("setContext", "bst.connected", true);
        fileProvider.setConnected(true);
        try {
          await checkAndLoadProject();
        } catch (err: any) {
          vscode.window.showErrorMessage(
            "Failed to load project: " + err.message,
          );
        }
      });

      ws.on("message", (data) => {
        handleMessage(data.toString());
      });

      ws.on("error", (err) => {
        vscode.window.showErrorMessage("WebSocket error: " + err.message);
      });

      ws.on("close", () => {
        connected = false;
        vscode.commands.executeCommand("setContext", "bst.connected", false);
        fileProvider.setConnected(false);
        fileProvider.clear();
        propertiesPanel.clear();
        vscode.window.showWarningMessage(
          "Disconnected from Better Studio server",
        );
      });
    }),
  );

  // --- Disconnect ---
  context.subscriptions.push(
    vscode.commands.registerCommand("bst.disconnect", () => {
      if (ws) {
        ws.close();
        ws = undefined;
      }
      connected = false;
      fileProvider.setConnected(false);
      fileProvider.clear();
      propertiesPanel.clear();
      vscode.commands.executeCommand("setContext", "bst.connected", false);
    }),
  );

  // --- Edit a property (called from properties panel inline button) ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bst.editProperty",
      async (item: PropertyItem) => {
        if (!item?.propKey || !item.ownerNode) {
          return;
        }

        const newValue = await vscode.window.showInputBox({
          prompt: `New value for "${item.propKey}"`,
          value: item.propValue ?? "",
        });
        if (newValue === undefined) {
          return;
        }

        try {
          await sendEdit({
            uuid: item.ownerNode.folderName.split(".")[
              item.ownerNode.folderName.split(".").length - 1
            ],
            action: "modify",
            target: "property",
            property: item.propKey,
            value: newValue,
          });
          propertiesPanel.update(item.ownerNode);
          vscode.window.showInformationMessage(`Updated ${item.propKey}`);
        } catch (err: any) {
          vscode.window.showErrorMessage("Edit failed: " + err.message);
        }
      },
    ),
  );

  // --- Open script in editor (double-click or context menu) ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bst.openScript",
      async (node: FileNode) => {
        if (!node?.scriptPath) {
          return;
        }
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(node.scriptPath),
        );
        await vscode.window.showTextDocument(doc);
      },
    ),
  );

  // --- Delete instance ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "bst.deleteInstance",
      async (node: FileNode) => {
        if (!node) {
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Delete "${node.label}"?`,
          { modal: true },
          "Delete",
        );
        if (confirm !== "Delete") {
          return;
        }

        try {
          await sendEdit({
            uuid: node.folderName.split(".")[
              node.folderName.split(".").length - 1
            ],
            action: "delete",
            target: "instance",
          });
          await refreshFileTree();
          propertiesPanel.clear();
          vscode.window.showInformationMessage(`Deleted ${node.label}`);
        } catch (err: any) {
          vscode.window.showErrorMessage("Delete failed: " + err.message);
        }
      },
    ),
  );

  // --- Close project ---
  context.subscriptions.push(
    vscode.commands.registerCommand("bst.closeProject", async () => {
      try {
        await sendCliCommand("close-project");
        fileProvider.clear();
        propertiesPanel.clear();
        vscode.window.showInformationMessage("Project closed");
      } catch (err: any) {
        vscode.window.showErrorMessage("Close failed: " + err.message);
      }
    }),
  );

  // --- Refresh file tree ---
  context.subscriptions.push(
    vscode.commands.registerCommand("bst.refresh", async () => {
      try {
        await refreshFileTree();
      } catch (err: any) {
        vscode.window.showErrorMessage("Refresh failed: " + err.message);
      }
    }),
  );

  // --- Open project selector (shown when connected but no project open) ---
  context.subscriptions.push(
    vscode.commands.registerCommand("bst.selectProject", async () => {
      try {
        await checkAndLoadProject();
      } catch (err: any) {
        vscode.window.showErrorMessage(
          "Failed to load project: " + err.message,
        );
      }
    }),
  );
}

// ------------------- Project Loading -------------------

async function checkAndLoadProject() {
  const status = await sendCliCommand("status");

  if (!status.projectOpen) {
    const listResp = await sendCliCommand("list-projects");
    const projects: string[] = listResp.projects ?? [];

    if (projects.length === 0) {
      vscode.window.showWarningMessage("No projects found on server");
      fileProvider.showNoProjects();
      return;
    }

    const pick = await vscode.window.showQuickPick(projects, {
      placeHolder: "Select a project to open",
      title: "Open Project",
    });
    if (!pick) {
      return;
    }

    const openResp = await sendCliCommand("open-project", { name: pick });
    if (openResp.status !== "opened") {
      vscode.window.showErrorMessage("Failed to open project");
      return;
    }
    vscode.window.showInformationMessage(`Opened project: ${pick}`);
  } else {
    vscode.window.showInformationMessage(
      `Resuming project: ${status.currentProject}`,
    );
  }

  await refreshFileTree();
}

async function refreshFileTree() {
  const status = await sendCliCommand("status");
  if (!status.projectOpen || !status.unpackedPath) {
    fileProvider.clear();
    return;
  }

  const resolvedPath = status.unpackedPath as string;

  if (!fs.existsSync(resolvedPath)) {
    vscode.window.showWarningMessage(
      `Unpacked path does not exist: ${resolvedPath}`,
    );
    fileProvider.clear();
    return;
  }

  const tree = buildTreeFromDisk(resolvedPath);
  fileProvider.refresh(tree, resolvedPath);
}

export function checkWebSocketAvailable(
  timeoutMs = 2000,
  init = false,
): Promise<boolean> {
  const url = "ws://localhost:3000";
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        resolve(false);
      }
    }, timeoutMs);

    ws.onopen = () => {
      if (settled) {
        if (init) {
          setTimeout(() => {
            checkWebSocketAvailable(timeoutMs, true);
          }, 1000);
          serverReady = true;
          vscode.commands.executeCommand("setContext", "bst.serverReady", true);
        }
        return;
      }
      settled = true;
      clearTimeout(timeout);
      ws.close();
      resolve(true);
    };

    ws.onerror = () => {
      if (settled) {
        if (init) {
          setTimeout(() => {
            checkWebSocketAvailable(timeoutMs, true);
          }, 1000);
          serverReady = false;
          vscode.commands.executeCommand(
            "setContext",
            "bst.serverReady",
            false,
          );
        }
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(false);
    };
  });
}

// ------------------- Build file tree from unpacked folder -------------------

interface DiskEntry {
  name: string;
  className: string;
  folderName: string; // relative folder segment, e.g. "Part.Part.abc-123"
  fullPath: string;
  hasScript: boolean;
  children: DiskEntry[];
}

function buildTreeFromDisk(rootPath: string): DiskEntry[] {
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  const entries: DiskEntry[] = [];

  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const item of items) {
    if (!item.isDirectory()) {
      continue;
    }

    const folderName = item.name;

    // Skip the project metadata folder / any folder that isn't Name.ClassName.GUID
    const parts = folderName.split(".");
    if (parts.length < 3) {
      continue;
    }

    const instanceName = parts[0];
    const className = parts.slice(1, parts.length - 1).join("."); // handle dots in class names
    if (checkHidden(className)) {
      continue;
    }
    const fullPath = path.join(rootPath, folderName);
    const hasScript = fs.existsSync(path.join(fullPath, "code.lua"));
    const children = buildTreeFromDisk(fullPath);

    entries.push({
      name: instanceName,
      className,
      folderName,
      fullPath,
      hasScript,
      children,
    });
  }

  // Sort: folders first, then by name
  entries.sort((a, b) => {
    if (a.children.length > 0 && b.children.length === 0) {
      return -1;
    }
    if (a.children.length === 0 && b.children.length > 0) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });

  return entries;
}

// ------------------- Deactivation -------------------

export function deactivate() {
  if (ws) {
    ws.close();
  }
}

// ------------------- Icon mapping -------------------

const CLASS_ICONS: Record<string, string> = {
  Part: "Part",
  MeshPart: "MeshPart",
  UnionOperation: "UnionOperation",
  Model: "Model",
  Folder: "Folder",
  Script: "Script",
  LocalScript: "LocalScript",
  ModuleScript: "ModuleScript",
  RemoteEvent: "RemoteEvent",
  RemoteFunction: "RemoteFunction",
  BindableEvent: "BindableEvent",
  BindableFunction: "BindableFunction",
  StringValue: "StringValue",
  IntValue: "IntValue",
  NumberValue: "NumberValue",
  BoolValue: "BoolValue",
  ObjectValue: "ObjectValue",
  Configuration: "Configuration",
  Workspace: "Workspace",
  ReplicatedStorage: "ReplicatedStorage",
  ServerStorage: "ServerStorage",
  ServerScriptService: "ServerScriptService",
  StarterGui: "StarterGui",
  StarterPack: "StarterPack",
  StarterPlayer: "StarterPlayer",
  Teams: "Teams",
  SoundService: "SoundService",
  Lighting: "Lighting",
  Players: "Players",
  StarterPlayerScripts: "Folder",
  StarterCharacterScripts: "Folder",
};

const HIDDEN_CLASSES: string[] = [
  "AssetService",
  "AvatarSettings",
  "CollectionService",
  "ContextActionService",
  "CookiesService",
  "GSGDictionaryService",
  "DataStoreService",
  "VoiceChatService",
];

function checkHidden(className: string): boolean {
  return HIDDEN_CLASSES.includes(className);
}

function getIconForClass(
  className: string,
  hasChildren: boolean,
): vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri } {
  const iconName = CLASS_ICONS[className];
  if (iconName && extensionPath) {
    const iconUri = vscode.Uri.file(
      path.join(extensionPath, "old-studio-icons", `${iconName}.png`),
    );
    return { light: iconUri, dark: iconUri };
  }

  if (hasChildren) {
    return new vscode.ThemeIcon("folder");
  }
  return new vscode.ThemeIcon("symbol-misc");
}

// ------------------- File Explorer -------------------

class FileNode extends vscode.TreeItem {
  children: FileNode[];
  className: string;
  folderName: string;
  fullPath: string;
  scriptPath?: string;

  constructor(entry: DiskEntry) {
    const hasChildren = entry.children.length > 0;
    super(
      entry.name,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    this.className = entry.className;
    this.folderName = entry.folderName;
    this.fullPath = entry.fullPath;
    this.children = entry.children.map((c) => new FileNode(c));
    this.description = entry.className;
    this.tooltip = `${entry.name} (${entry.className})`;

    // Context value drives which inline buttons appear in package.json
    if (entry.hasScript) {
      this.contextValue = "bstInstance_script";
      this.scriptPath = path.join(entry.fullPath, "code.lua");
    } else {
      this.contextValue = "bstInstance";
    }

    this.iconPath = getIconForClass(entry.className, entry.hasScript);

    // Double-click on a script node opens it; single-click on anything selects it
    // Selection is handled via onDidChangeSelection on the TreeView.
    // For script nodes we set a command so double-click opens the file.
    if (entry.hasScript) {
      this.command = {
        command: "bst.openScript",
        title: "Open Script",
        arguments: [this],
      };
    }
    // Non-script nodes have no command so single-click just selects them,
    // which fires onDidChangeSelection to populate the properties panel.
  }
}

/** Placeholder item shown when not connected or no project */
class PlaceholderNode extends vscode.TreeItem {
  constructor(label: string, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon("info");
    this.contextValue = "placeholder";
  }
}

type FileTreeItem = FileNode | PlaceholderNode;

class FileProvider implements vscode.TreeDataProvider<FileTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    FileTreeItem | undefined | null
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: FileTreeItem[] = [];
  private _connected = false;

  getTreeItem(element: FileTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FileTreeItem): FileTreeItem[] {
    if (!element) {
      return this.roots;
    }
    if (element instanceof FileNode) {
      return element.children;
    }
    return [];
  }

  setConnected(val: boolean) {
    this._connected = val;
    if (!val) {
      this.roots = [
        new PlaceholderNode("Not connected", "Click Connect in the toolbar"),
      ];
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  showNoProjects() {
    this.roots = [
      new PlaceholderNode("No projects found", "Add .rbxl files to ./projects"),
    ];
    this._onDidChangeTreeData.fire(undefined);
  }

  refresh(entries: DiskEntry[], _unpackedPath: string) {
    if (entries.length === 0) {
      this.roots = [new PlaceholderNode("Project is empty")];
    } else {
      this.roots = entries.map((e) => new FileNode(e));
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  clear() {
    if (this._connected) {
      this.roots = [
        new PlaceholderNode(
          "No project open",
          'Use "Select Project" to open one',
        ),
      ];
    } else {
      this.roots = [
        new PlaceholderNode("Not connected", "Click Connect in the toolbar"),
      ];
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  findNodeByScriptPath(fsPath: string): FileNode | undefined {
    const search = (nodes: FileTreeItem[]): FileNode | undefined => {
      for (const n of nodes) {
        if (!(n instanceof FileNode)) {
          continue;
        }
        if (n.scriptPath === fsPath) {
          return n;
        }
        const found = search(n.children);
        if (found) {
          return found;
        }
      }
      return undefined;
    };
    return search(this.roots);
  }
}

// ------------------- Properties Panel -------------------

class PropertyItem extends vscode.TreeItem {
  propKey?: string;
  propValue?: string;
  ownerNode?: FileNode;

  constructor(
    label: string,
    opts?: { propKey: string; propValue: string; ownerNode: FileNode },
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (opts) {
      this.propKey = opts.propKey;
      this.propValue = opts.propValue;
      this.ownerNode = opts.ownerNode;
      this.description = opts.propValue;
      this.tooltip = `${opts.propKey}: ${opts.propValue}`;
      this.contextValue = "bstProperty";
    }
  }
}

/** Parse a flat YAML file without a library — handles quoted and unquoted string values */
function parseSimpleYaml(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    // Match: key: value  OR  key: 'value'  OR  key: "value"
    const match = line.match(
      /^([A-Za-z_][A-Za-z0-9_]*):\s*(['"]?)(.*)(\2)\s*$/,
    );
    if (match) {
      const [, key, , value] = match;
      result[key] = value;
    }
  }
  return result;
}

class PropertiesPanel implements vscode.TreeDataProvider<PropertyItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    PropertyItem | undefined | null
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private items: PropertyItem[] = [];

  getTreeItem(element: PropertyItem): vscode.TreeItem {
    return element;
  }
  getChildren(): PropertyItem[] {
    return this.items;
  }

  update(node: FileNode) {
    this.items = [];

    // Header section
    const nameItem = new PropertyItem(`${node.label}`);
    nameItem.description = node.className;
    nameItem.iconPath = getIconForClass(node.className, !!node.scriptPath);
    nameItem.tooltip = `${node.label} (${node.className})`;
    this.items.push(nameItem);

    // Read & display properties from YAML
    const propsFile = path.join(node.fullPath, "properties.yaml");
    if (fs.existsSync(propsFile)) {
      try {
        const raw = fs.readFileSync(propsFile, "utf-8");
        const props = parseSimpleYaml(raw);

        if (Object.keys(props).length === 0) {
          this.items.push(new PropertyItem("(no properties)"));
        } else {
          for (const [key, value] of Object.entries(props)) {
            this.items.push(
              new PropertyItem(key, {
                propKey: key,
                propValue: value,
                ownerNode: node,
              }),
            );
          }
        }
      } catch {
        this.items.push(new PropertyItem("(error reading properties.yaml)"));
      }
    } else {
      this.items.push(new PropertyItem("(no properties.yaml found)"));
    }

    // Script shortcut
    if (node.scriptPath) {
      const scriptItem = new PropertyItem("Open Script");
      scriptItem.iconPath = new vscode.ThemeIcon("file-code");
      scriptItem.tooltip = "Open script in editor";
      scriptItem.command = {
        command: "bst.openScript",
        title: "Open Script",
        arguments: [node],
      };
      this.items.push(scriptItem);
    }

    this._onDidChangeTreeData.fire(undefined);
  }

  clear() {
    this.items = [];
    this._onDidChangeTreeData.fire(undefined);
  }
}
