/**
 * The Lore sidebar: a tree of the notes attached to the directory you are
 * currently working in, plus folder- and repo-scoped notes — grouped by project
 * when the workspace contains more than one `.lore/`.
 *
 * A TreeDataProvider rather than a webview — grouping, theming, keyboard
 * navigation, context menus, and the empty state all come for free, and it
 * follows the user's colour theme without being styled twice.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LORE_DIRECTORY,
  Note,
  isDirectoryNote,
  isSamePath,
  noteRoot,
  notesForDirectory,
  rootContaining,
  workspaceNotes,
  workspaceRelativePath,
} from './noteStore';

const MAX_TOOLTIP_LENGTH = 600;

type GroupKind = 'directory' | 'all' | 'personal' | 'team' | 'workspace' | 'unanchored';

/**
 * One Lore project — a directory with its own `.lore/`. Only shown when the
 * workspace holds more than one; a single project would just be a folder you
 * have to expand before reaching anything.
 */
class ProjectItem extends vscode.TreeItem {
  readonly itemType = 'project' as const;

  constructor(readonly root: string, label: string, noteCount: number) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    // An id is what makes VS Code remember that you collapsed this project;
    // without one every reload would spring it back open.
    this.id = root;
    this.description = `${noteCount}`;
    this.tooltip = root;
    this.iconPath = new vscode.ThemeIcon('folder-library');
    this.contextValue = 'loreProject';
  }
}

class GroupItem extends vscode.TreeItem {
  readonly itemType = 'group' as const;

  constructor(
    label: string,
    readonly groupKind: GroupKind,
    readonly notes: Note[],
    icon: vscode.ThemeIcon,
    /** Whether these notes come from more than one directory. */
    readonly spansDirectories = false,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = icon;
    this.contextValue = `loreGroup.${groupKind}`;
  }
}

interface NoteItemOptions {
  unanchored?: boolean;
  /** Show the full path, for lists spanning more than one directory. */
  showDirectory?: boolean;
}

class NoteItem extends vscode.TreeItem {
  readonly itemType = 'note' as const;

  constructor(
    readonly note: Note,
    { unanchored = false, showDirectory = false }: NoteItemOptions = {},
  ) {
    super(note.title, vscode.TreeItemCollapsibleState.None);

    this.description = unanchored ? 'anchor lost' : describeLocation(note, showDirectory);
    this.tooltip = buildTooltip(note);
    // Theme colours rather than hex, so the icons stay legible in every theme.
    this.iconPath = unanchored
      ? new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon(
          'circle-filled',
          new vscode.ThemeColor(note.scope === 'personal' ? 'charts.green' : 'charts.blue'),
        );
    this.command = {
      command: 'lore.reveal',
      title: 'Go to Code',
      arguments: [note],
    };
    // Scope stays in the context value even when the anchor is lost, so Share
    // and Make Personal remain available on exactly the notes a user is most
    // likely to want to clean up. Menus match these with a prefix regex.
    this.contextValue = `loreNote.${note.scope}${unanchored ? '.unanchored' : ''}`;
  }
}

export type LoreTreeItem = ProjectItem | GroupItem | NoteItem;

export class NoteTreeProvider implements vscode.TreeDataProvider<LoreTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private notes: Note[] = [];
  private roots: string[] = [];
  private unanchoredNotePaths = new Set<string>();
  private lastCodeLocation: { root: string; directory: string } | undefined;

  /** Replace the note set, and the projects it came from, after reading from disk. */
  setNotes(notes: Note[], roots: string[]): void {
    this.notes = notes;
    this.roots = roots;
    this.changeEmitter.fire();
  }

  /**
   * Record which notes the renderer could not place. Only fires a change when
   * the set actually differs — this arrives after every repaint, and rebuilding
   * the tree on each keystroke would make it flicker.
   */
  setUnanchoredNotePaths(notePaths: Set<string>): void {
    if (haveSameMembers(this.unanchoredNotePaths, notePaths)) return;
    this.unanchoredNotePaths = notePaths;
    this.changeEmitter.fire();
  }

  /** Re-render with the notes we already have, e.g. when the active editor changes. */
  refreshView(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(item: LoreTreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(item?: LoreTreeItem): LoreTreeItem[] {
    if (!item) return this.rootLevel();
    if (item.itemType === 'project') return this.groupsForProject(item.root);
    if (item.itemType === 'group') return this.childrenOfGroup(item);
    return [];
  }

  /**
   * One project's notes sit at the top level; several are grouped under a row
   * each, so a monorepo or multi-root workspace reads as the tree of projects
   * it actually is.
   */
  private rootLevel(): LoreTreeItem[] {
    const projects = this.roots.filter((root) => this.notesIn(root).length > 0);

    // With nothing stored anywhere, return nothing so the view's welcome content
    // handles onboarding instead of showing empty groups.
    if (projects.length === 0) return [];
    if (projects.length === 1) return this.groupsForProject(projects[0]);

    return projects.map(
      (root) => new ProjectItem(root, projectLabel(root), this.notesIn(root).length),
    );
  }

  private notesIn(root: string): Note[] {
    return this.notes.filter((note) => isSamePath(noteRoot(note), root));
  }

  private groupsForProject(root: string): LoreTreeItem[] {
    const notes = this.notesIn(root);
    if (notes.length === 0) return [];

    const groups: LoreTreeItem[] = [];

    const directory = this.currentCodeDirectoryIn(root);
    if (directory !== undefined) {
      const directoryNotes = notesForDirectory(notes, directory);
      // Shown even when empty: the label is how you tell which directory the
      // list below is describing.
      groups.push(
        new GroupItem(
          directory === '' ? './' : `${directory}/`,
          'directory',
          directoryNotes,
          new vscode.ThemeIcon('folder'),
        ),
      );
    } else {
      // No file has been opened yet, so there is no directory to scope to.
      // Listing every note beats listing none — an empty panel here is
      // indistinguishable from a repository that has no notes at all.
      const fileNotes = notes.filter((note) => !isDirectoryNote(note));
      if (fileNotes.length > 0) {
        groups.push(
          new GroupItem(
            `All Notes (${fileNotes.length})`,
            'all',
            fileNotes,
            new vscode.ThemeIcon('files'),
            true,
          ),
        );
      }
    }

    const folderNotes = workspaceNotes(notes);
    if (folderNotes.length > 0) {
      groups.push(
        new GroupItem(
          // "Project" rather than "Workspace": a workspace can hold several of these.
          `Project (${folderNotes.length})`,
          'workspace',
          folderNotes,
          new vscode.ThemeIcon('root-folder'),
          true,
        ),
      );
    }

    return groups;
  }

  private childrenOfGroup(group: GroupItem): LoreTreeItem[] {
    // Groups that span directories need the path on each row to stay unambiguous.
    const showDirectory = group.spansDirectories;

    if (group.groupKind === 'unanchored') {
      return group.notes.map((note) => new NoteItem(note, { unanchored: true, showDirectory }));
    }
    // Only the two file-note groups split by scope; the rest are already leaves.
    if (group.groupKind !== 'directory' && group.groupKind !== 'all') {
      return group.notes.map((note) => new NoteItem(note, { showDirectory }));
    }

    const unanchoredNotes = group.notes.filter((note) => this.unanchoredNotePaths.has(note.notePath));
    const anchoredNotes = group.notes.filter((note) => !this.unanchoredNotePaths.has(note.notePath));

    const personalNotes = anchoredNotes.filter((note) => note.scope === 'personal');
    const teamNotes = anchoredNotes.filter((note) => note.scope === 'team');

    const groups: LoreTreeItem[] = [];
    if (personalNotes.length > 0) {
      groups.push(
        new GroupItem(
          `My Notes (${personalNotes.length})`,
          'personal',
          personalNotes,
          new vscode.ThemeIcon('account'),
          showDirectory,
        ),
      );
    }
    if (teamNotes.length > 0) {
      groups.push(
        new GroupItem(
          `Team Notes (${teamNotes.length})`,
          'team',
          teamNotes,
          new vscode.ThemeIcon('organization'),
          showDirectory,
        ),
      );
    }
    if (unanchoredNotes.length > 0) {
      groups.push(
        new GroupItem(
          `Unanchored (${unanchoredNotes.length})`,
          'unanchored',
          unanchoredNotes,
          new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')),
          showDirectory,
        ),
      );
    }
    return groups;
  }

  /**
   * The directory to scope `root`'s list to, or undefined when the file you are
   * looking at belongs to some other project.
   *
   * Opening a note file would otherwise yank the tree over to `.lore/local/`,
   * which happens immediately after creating a note — so `.lore/` is ignored and
   * the last real code directory stays on screen.
   */
  private currentCodeDirectoryIn(root: string): string | undefined {
    const location = this.activeCodeLocation();
    if (location !== undefined) this.lastCodeLocation = location;

    const remembered = this.lastCodeLocation;
    return remembered && isSamePath(remembered.root, root) ? remembered.directory : undefined;
  }

  /** Which project the active editor is in, and where inside it. */
  private activeCodeLocation(): { root: string; directory: string } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return undefined;

    const root = rootContaining(this.roots, editor.document.uri.fsPath);
    if (root === undefined) return undefined;

    const relativePath = workspaceRelativePath(root, editor.document.uri.fsPath);
    if (relativePath === undefined || relativePath.startsWith(`${LORE_DIRECTORY}/`)) return undefined;

    const directory = path.posix.dirname(relativePath);
    return { root, directory: directory === '.' ? '' : directory };
  }
}

function projectLabel(root: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  if (!folder) return path.basename(root);

  const relativePath = workspaceRelativePath(folder.uri.fsPath, root);
  if (relativePath === undefined || relativePath === '.') return folder.name;

  // A multi-root workspace can hold two `packages/api` folders, so name the
  // workspace folder as well; inside a single repository that prefix is noise.
  const folderCount = vscode.workspace.workspaceFolders?.length ?? 0;
  return folderCount > 1 ? `${folder.name}/${relativePath}` : relativePath;
}

function describeLocation(note: Note, showDirectory: boolean): string {
  const location = showDirectory ? note.targetPath : path.basename(note.targetPath);
  return note.line === undefined ? location : `${location}:${note.line}`;
}

function haveSameMembers(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const member of left) if (!right.has(member)) return false;
  return true;
}

function buildTooltip(note: Note): vscode.MarkdownString {
  const body = note.body.length > MAX_TOOLTIP_LENGTH
    ? `${note.body.slice(0, MAX_TOOLTIP_LENGTH)}…`
    : note.body;

  const tooltip = new vscode.MarkdownString(body || '_Empty note_');
  tooltip.supportThemeIcons = true;
  return tooltip;
}
