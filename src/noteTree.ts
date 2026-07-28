/**
 * The Lore sidebar: a tree of the notes attached to the directory you are
 * currently working in, plus folder- and repo-scoped notes.
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
  notesForDirectory,
  toPosixPath,
  workspaceNotes,
} from './noteStore';

const MAX_TOOLTIP_LENGTH = 600;

type GroupKind = 'directory' | 'personal' | 'team' | 'workspace' | 'unanchored';

class GroupItem extends vscode.TreeItem {
  readonly itemType = 'group' as const;

  constructor(
    label: string,
    readonly groupKind: GroupKind,
    readonly notes: Note[],
    icon: vscode.ThemeIcon,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = icon;
    this.contextValue = `loreGroup.${groupKind}`;
  }
}

class NoteItem extends vscode.TreeItem {
  readonly itemType = 'note' as const;

  constructor(readonly note: Note, isUnanchored = false) {
    super(note.title, vscode.TreeItemCollapsibleState.None);

    this.description = isUnanchored ? 'anchor lost' : describeLocation(note);
    this.tooltip = buildTooltip(note);
    // Theme colours rather than hex, so the icons stay legible in every theme.
    this.iconPath = isUnanchored
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
    this.contextValue = isUnanchored ? 'loreNote.unanchored' : `loreNote.${note.scope}`;
  }
}

export type LoreTreeItem = GroupItem | NoteItem;

export class NoteTreeProvider implements vscode.TreeDataProvider<LoreTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private notes: Note[] = [];
  private unanchoredNotePaths = new Set<string>();
  private lastCodeDirectory: string | undefined;

  constructor(private readonly workspaceRoot: string) {}

  /** Replace the note set after reading from disk. */
  setNotes(notes: Note[]): void {
    this.notes = notes;
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
    if (!item) return this.rootGroups();
    if (item.itemType === 'group') return this.childrenOfGroup(item);
    return [];
  }

  private rootGroups(): LoreTreeItem[] {
    // With nothing stored anywhere, return nothing so the view's welcome content
    // handles onboarding instead of showing empty groups.
    if (this.notes.length === 0) return [];

    const groups: LoreTreeItem[] = [];

    const directory = this.currentCodeDirectory();
    if (directory !== undefined) {
      const directoryNotes = notesForDirectory(this.notes, directory);
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
    }

    const folderNotes = workspaceNotes(this.notes);
    if (folderNotes.length > 0) {
      groups.push(
        new GroupItem(
          `Workspace (${folderNotes.length})`,
          'workspace',
          folderNotes,
          new vscode.ThemeIcon('root-folder'),
        ),
      );
    }

    return groups;
  }

  private childrenOfGroup(group: GroupItem): LoreTreeItem[] {
    if (group.groupKind === 'unanchored') {
      return group.notes.map((note) => new NoteItem(note, true));
    }
    if (group.groupKind !== 'directory') {
      return group.notes.map((note) => new NoteItem(note));
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
        ),
      );
    }
    return groups;
  }

  /**
   * The directory of the active editor.
   *
   * Opening a note file would otherwise yank the tree over to `.lore/local/`,
   * which happens immediately after creating a note — so `.lore/` is ignored and
   * the last real code directory stays on screen.
   */
  private currentCodeDirectory(): string | undefined {
    const directory = activeEditorDirectory(this.workspaceRoot);
    if (directory !== undefined && !directory.startsWith(LORE_DIRECTORY)) {
      this.lastCodeDirectory = directory;
    }
    return this.lastCodeDirectory;
  }
}

function activeEditorDirectory(workspaceRoot: string): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return undefined;

  const relativePath = path.relative(workspaceRoot, editor.document.uri.fsPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return undefined;

  const directory = path.dirname(relativePath);
  return directory === '.' ? '' : toPosixPath(directory);
}

function describeLocation(note: Note): string {
  const fileName = path.basename(note.targetPath);
  return note.line === undefined ? fileName : `${fileName}:${note.line}`;
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
