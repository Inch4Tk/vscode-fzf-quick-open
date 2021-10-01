'use strict';

import { Terminal, window, workspace, Uri, commands, Position, Selection, Range, ExtensionContext, extensions } from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as cp from 'child_process';

let fzfTerminal: Terminal | undefined = undefined;
let fzfTerminalPwd: Terminal | undefined = undefined;

let findCmd: string;
let fzfCmd: string;
let fzfInputCmd: string | undefined;
let workspaceFolderpaths: string | undefined;
let initialCwd: string;
let rgFlags: string;
let fzfPipe: string | undefined;
let fzfPipeScript: string;
let useWorkspaceFoldersFzf: boolean;
let useWorkspaceFoldersRg: boolean;
let closeTerminalAfterSearch: boolean;
let forceIgnoreFile: boolean;
let windowsNeedsEscape = false;
let fzfQuote = "'";

export const TERMINAL_NAME = "fzf terminal";
export const TERMINAL_NAME_PWD = "fzf pwd terminal";

export enum rgoptions {
	CaseSensitive = "Case sensitive",
	IgnoreCase = "Ignore case",
	SmartCase = "Smart case"
}

export const rgflagmap = new Map<string, string>([
	[rgoptions.CaseSensitive, "--case-sensitive"],
	[rgoptions.IgnoreCase, "--ignore-case"],
	[rgoptions.SmartCase, "--smart-case"]
]);

function showFzfTerminal(name: string, fzfTerminal: Terminal | undefined): Terminal {
	if (!fzfTerminal) {
		// Look for an existing terminal
		fzfTerminal = window.terminals.find((term) => { return term.name === name; });
	}
	if (!fzfTerminal) {
		// Create an fzf terminal
		if (!initialCwd && window.activeTextEditor) {
			initialCwd = path.dirname(window.activeTextEditor.document.fileName);
		}
		initialCwd = initialCwd || '';
		fzfTerminal = window.createTerminal({
			cwd: initialCwd,
			name: name
		});
	}
	fzfTerminal.show();
	return fzfTerminal;
}

function moveToPwd(term: Terminal) {
	if (window.activeTextEditor) {
		let cwd = path.dirname(window.activeTextEditor.document.fileName);
		term.sendText(`cd ${cwd}`);
	}
}

function xargsCmd() {
	if (process.platform === 'darwin') {
		return 'xargs -0';
	} else {
		return 'xargs -0 -r';
	}

}

function updateWorkspaceFolders() {
	if (useWorkspaceFoldersFzf || useWorkspaceFoldersRg) {
		const folders = workspace.workspaceFolders;
		if (!!folders && folders.length > 0) {
			const q = getQuote();
			workspaceFolderpaths = folders.map(f => `${q}${f.uri.fsPath}${q}`).join(" ");
			let ignore = "";
			if (forceIgnoreFile) {
				ignore = "--ignore-file .ignore";
			}
			fzfInputCmd = `fd .* ${workspaceFolderpaths} --type f ${ignore}`;
		}
	}
}

function applyConfig() {
	let cfg = workspace.getConfiguration('fzf-quick-open');
	fzfCmd = cfg.get('fuzzyCmd') as string ?? "fzf";
	findCmd = cfg.get('findDirectoriesCmd') as string;
	useWorkspaceFoldersFzf = cfg.get('useWorkspaceFoldersFzf') as boolean;
	useWorkspaceFoldersRg = cfg.get('useWorkspaceFoldersRg') as boolean;
	forceIgnoreFile = cfg.get('forceIgnoreFile') as boolean;
	closeTerminalAfterSearch = cfg.get('closeTerminalAfterSearch') as boolean;
	initialCwd = cfg.get('initialWorkingDirectory') as string;
	let rgopt = cfg.get('ripgrepSearchStyle') as string;
	rgFlags = (rgflagmap.get(rgopt) ?? "--case-sensitive") + ' ';
	rgFlags += cfg.get('ripgrepOptions') as string ?? "";
	rgFlags = rgFlags.trim();

	if (isWindows()) {
		let term = workspace.getConfiguration('terminal.integrated.shell').get('windows') as string;

		// support for new terminal profiles
		if (!term) {
			let defaultTerm: string | undefined = workspace.getConfiguration('terminal.integrated.defaultProfile').get('windows');
			if (!!defaultTerm) {
				let profiles: any = workspace.getConfiguration('terminal.integrated.profiles').get('windows');
				term = profiles?.[defaultTerm]?.path?.[0];
			}
		}

		let isWindowsCmd = term?.toLowerCase().endsWith("cmd.exe") ?? false;
		windowsNeedsEscape = !isWindowsCmd;
		// CMD doesn't support single quote.
		fzfQuote = isWindowsCmd ? '"' : "'";

	}
	fzfInputCmd = undefined;
	workspaceFolderpaths = undefined;
	updateWorkspaceFolders();
}

function isWindows() {
	return process.platform === 'win32';
}

function getPath(arg: string, pwd: string): string | undefined {
	if (!path.isAbsolute(arg)) {
		arg = path.join(pwd, arg);
	}
	if (fs.existsSync(arg)) {
		return arg;
	} else {
		return undefined;
	}
}

function escapeWinPath(origPath: string) {
	if (isWindows() && windowsNeedsEscape) {
		return origPath?.replace(/\\/g, '\\\\');
	} else {
		return origPath;
	}
}

function getFzfInputCmd() {
	return fzfInputCmd;
}

function getFzfCmd(useFd: boolean = true) {
	if (useFd && !!fzfInputCmd) {
		return `${getFzfInputCmd()} | ${fzfCmd}`;
	}
	return fzfCmd;
}

function getCodeOpenFileCmd() {
	return`${getFzfCmd()} | ${getFzfPipeScript()} open ${getFzfPipe()}`;
}

function getCodeOpenFolderCmd() {
	return `${getFzfCmd(false)} | ${getFzfPipeScript()} add ${getFzfPipe()}`;
}

function getFindCmd() {
	return findCmd;
}

function getFzfPipe() {
	let res = fzfPipe;
	if (res) {
		res = escapeWinPath(res);
	}
	return res;
}

function getFzfPipeScript() {
	return escapeWinPath(fzfPipeScript);
}

function getQuote() {
	return fzfQuote;
}

function processCommandInput(data: Buffer) {
	// close terminal
	if (closeTerminalAfterSearch) {
		let termname = window.activeTerminal?.name;
		if (termname == fzfTerminal?.name) {
			fzfTerminal?.hide();
		} else if (termname == fzfTerminalPwd?.name) {
			fzfTerminalPwd?.hide();
		}
	}

	// process command
	let [cmd, pwd, arg] = data.toString().trim().split('$$');
	cmd = cmd.trim(); pwd = pwd.trim(); arg = arg.trim();
	if (arg === "") { return }
	if (cmd === 'open') {
		let filename = getPath(arg, pwd);
		if (!filename) { return }
		window.showTextDocument(Uri.file(filename));
	} else if (cmd === 'add') {
		let folder = getPath(arg, pwd);
		if (!folder) { return }
		workspace.updateWorkspaceFolders(workspace.workspaceFolders ? workspace.workspaceFolders.length : 0, null, {
			uri: Uri.file(folder)
		});
		commands.executeCommand('workbench.view.explorer');
	} else if (cmd === 'rg') {
		let [file, linestr, colstr] = arg.split(':');
		let filename = getPath(file, pwd);
		if (!filename) { return };
		let line = parseInt(linestr) - 1;
		let col = parseInt(colstr) - 1;
		window.showTextDocument(Uri.file(filename)).then((ed) => {
			let start = new Position(line, col);
			ed.selection = new Selection(start, start);
			ed.revealRange(new Range(start, start));
		})
	}
}

function listenToFifo(fifo: string) {
	fs.open(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK , (err, fd) => {
		const pipe = new net.Socket({fd: fd, allowHalfOpen: true });
		pipe.on('data', (data) => {
			processCommandInput(data);
		})
		pipe.on('end', () => {
			listenToFifo(fifo);
		})
	})
}

function setupWindowsPipe() {
	let server = net.createServer((socket) => {
		socket.on('data', (data) => {
			processCommandInput(data);
		})
	});
	let idx = 0;
	while (!fzfPipe) {
		try {
			let pipe = `\\\\?\\pipe\\fzf-pipe-${process.pid}`;
			if (idx > 0) { pipe += `-${idx}`; }
			server.listen(pipe);
			fzfPipe = pipe;
		} catch (e) {
			if (e.code === 'EADDRINUSE') {
				// Try again for a new address
				++idx;
			} else {
				// Bad news
				throw e;
			}
		}
	}
}

function setupPOSIXPipe() {
	let idx = 0;
	while (!fzfPipe && idx < 10) {
		try {
			let pipe = path.join(os.tmpdir(), `fzf-pipe-${process.pid}`);
			if (idx > 0) { pipe += `-${idx}`; }
			cp.execSync(`mkfifo -m 600 ${pipe}`);
			fzfPipe = pipe;
		} catch (e) {
			// Try again for a new address
			++idx;
		}
	}
	listenToFifo(fzfPipe as string);
}

function setupPipesAndListeners() {
	if (isWindows()) {
		setupWindowsPipe();
	} else {
		setupPOSIXPipe();
	}
}

export function activate(context: ExtensionContext) {
	applyConfig();
	setupPipesAndListeners();
	fzfPipeScript = extensions.getExtension('rlivings39.fzf-quick-open')?.extensionPath ?? "";
	fzfPipeScript = path.join(fzfPipeScript, 'scripts', 'topipe.' + (isWindows() ? "bat" : "sh"));
	workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('fzf-quick-open') || e.affectsConfiguration('terminal.integrated.shell.windows') || e.affectsConfiguration('terminal.integrated.profiles.windows') || e.affectsConfiguration('terminal.integrated.defaultProfile.windows')) {
			applyConfig();
		}
	})

	context.subscriptions.push(commands.registerCommand('fzf-quick-open.runFzfFile', () => {
		let term = showFzfTerminal(TERMINAL_NAME, fzfTerminal);
		fzfTerminal = term;
		term.sendText(getCodeOpenFileCmd(), true);
	}));

	context.subscriptions.push(commands.registerCommand('fzf-quick-open.runFzfFilePwd', () => {
		let term = showFzfTerminal(TERMINAL_NAME_PWD, fzfTerminalPwd);
		fzfTerminalPwd = term;
		moveToPwd(term);
		term.sendText(getCodeOpenFileCmd(), true);
	}));

	context.subscriptions.push(commands.registerCommand('fzf-quick-open.runFzfAddWorkspaceFolder', () => {
		let term = showFzfTerminal(TERMINAL_NAME, fzfTerminal);
		fzfTerminal = term;
		term.sendText(`${getFindCmd()} | ${getCodeOpenFolderCmd()}`, true);
	}));

	context.subscriptions.push(commands.registerCommand('fzf-quick-open.runFzfAddWorkspaceFolderPwd', () => {
		let term = showFzfTerminal(TERMINAL_NAME_PWD, fzfTerminalPwd);
		fzfTerminalPwd = term;
		moveToPwd(term);
		term.sendText(`${getFindCmd()} | ${getCodeOpenFolderCmd()}`, true);
	}));

	context.subscriptions.push(commands.registerCommand('fzf-quick-open.runFzfSearch', async () => {
		let pattern = await getSearchText();
		if (pattern === undefined) {
			return;
		}
		let term = showFzfTerminal(TERMINAL_NAME, fzfTerminal);
		fzfTerminal = term;
		term.sendText(makeSearchCmd(pattern), true);
	}));

	context.subscriptions.push(commands.registerCommand('fzf-quick-open.runFzfSearchPwd', async () => {
		let pattern = await getSearchText();
		if (pattern === undefined) {
			return;
		}
		let term = showFzfTerminal(TERMINAL_NAME_PWD, fzfTerminalPwd);
		fzfTerminalPwd = term;
		moveToPwd(term);
		term.sendText(makeSearchCmd(pattern), true);
	}));

	window.onDidCloseTerminal((terminal) => {
		switch (terminal.name) {
			case TERMINAL_NAME:
				fzfTerminal = undefined;
				break;

			case TERMINAL_NAME_PWD:
				fzfTerminalPwd = undefined
				break;
		}
	});
}

async function getSearchText(): Promise<string | undefined> {
	let activeSelection = window.activeTextEditor?.selection;
	let value: string | undefined = undefined;

	if (activeSelection) {
		let activeRange: Range | undefined;
		if (activeSelection.isEmpty) {
			activeRange = window.activeTextEditor?.document.getWordRangeAtPosition(activeSelection.active);
		} else {
			activeRange = activeSelection;
		}
		value = activeRange ? window.activeTextEditor?.document.getText(activeRange) : undefined
	}

	let pattern = await window.showInputBox({
		prompt: "Search pattern",
		value: value
	});
	return pattern;
}

export function deactivate() {
	if (!isWindows() && fzfPipe) {
		fs.unlinkSync(fzfPipe);
		fzfPipe = undefined;
	}
}

/**
 * Return the command used to invoke rg. Exported to allow unit testing.
 * @param pattern Pattern to search for
 */
export function makeSearchCmd(pattern: string): string {
	let q = getQuote();
	let rgSearchPath = "";
	if (useWorkspaceFoldersRg && !!workspaceFolderpaths) {
		rgSearchPath = workspaceFolderpaths;
	}
	let ignore = "";
	if (forceIgnoreFile) {
		ignore = "--ignore-file .ignore";
	}
	const cmd = `rg ${q}${pattern}${q} ${rgSearchPath} ${rgFlags} --vimgrep --color ansi ${ignore} | ${getFzfCmd(false)} --ansi | ${getFzfPipeScript()} rg "${getFzfPipe()}"`;
	return cmd;
}
