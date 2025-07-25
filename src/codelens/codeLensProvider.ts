import type {
	CancellationToken,
	CodeLensProvider,
	Command,
	Disposable,
	DocumentSelector,
	DocumentSymbol,
	Event,
	TextDocument,
	Uri,
} from 'vscode';
import { CodeLens, EventEmitter, Location, Position, Range, SymbolInformation, SymbolKind } from 'vscode';
import type { DiffWithPreviousCommandArgs } from '../commands/diffWithPrevious';
import type { OpenOnRemoteCommandArgs } from '../commands/openOnRemote';
import type { ShowCommitsInViewCommandArgs } from '../commands/showCommitsInView';
import type { ShowQuickCommitCommandArgs } from '../commands/showQuickCommit';
import type { ShowQuickCommitFileCommandArgs } from '../commands/showQuickCommitFile';
import type { ShowQuickFileHistoryCommandArgs } from '../commands/showQuickFileHistory';
import type { ToggleFileChangesAnnotationCommandArgs } from '../commands/toggleFileAnnotations';
import type { CodeLensCommands, CodeLensConfig, CodeLensLanguageScope } from '../config';
import { trackableSchemes } from '../constants';
import type { GlCommands } from '../constants.commands';
import type { Container } from '../container';
import type { GitUri } from '../git/gitUri';
import type { GitBlame } from '../git/models/blame';
import type { GitCommit } from '../git/models/commit';
import { RemoteResourceType } from '../git/models/remoteResource';
import { createCommand, executeCoreCommand } from '../system/-webview/command';
import { configuration } from '../system/-webview/configuration';
import { isVirtualUri } from '../system/-webview/vscode/uris';
import { is, once } from '../system/function';
import { filterMap, find, first, join, map } from '../system/iterable';
import { getLoggableName, Logger } from '../system/logger';
import { startLogScope } from '../system/logger.scope';
import { pluralize } from '../system/string';

class GitRecentChangeCodeLens extends CodeLens {
	constructor(
		public readonly languageId: string,
		public readonly symbol: DocumentSymbol | SymbolInformation,
		public readonly uri: GitUri | undefined,
		public readonly dateFormat: string | null,
		private readonly blame: (() => GitBlame | undefined) | undefined,
		public readonly blameRange: Range,
		public readonly isFullRange: boolean,
		range: Range,
		public readonly desiredCommand: CodeLensCommands | false,
		command?: Command | undefined,
	) {
		super(range, command);
	}

	getBlame(): GitBlame | undefined {
		return this.blame?.();
	}
}

class GitAuthorsCodeLens extends CodeLens {
	constructor(
		public readonly languageId: string,
		public readonly symbol: DocumentSymbol | SymbolInformation,
		public readonly uri: GitUri | undefined,
		private readonly blame: () => GitBlame | undefined,
		public readonly blameRange: Range,
		public readonly isFullRange: boolean,
		range: Range,
		public readonly desiredCommand: CodeLensCommands | false,
	) {
		super(range);
	}

	getBlame(): GitBlame | undefined {
		return this.blame();
	}
}

export class GitCodeLensProvider implements CodeLensProvider, Disposable {
	static selector: DocumentSelector = [...map(trackableSchemes, scheme => ({ scheme: scheme }))];

	private _onDidChangeCodeLenses = new EventEmitter<void>();
	get onDidChangeCodeLenses(): Event<void> {
		return this._onDidChangeCodeLenses.event;
	}

	constructor(private readonly container: Container) {}

	dispose(): void {
		this._onDidChangeCodeLenses.dispose();
	}

	reset(): void {
		this._onDidChangeCodeLenses.fire();
	}

	async provideCodeLenses(document: TextDocument, token: CancellationToken): Promise<CodeLens[]> {
		// Since we can't currently blame edited virtual documents, don't even attempt anything if dirty
		if (document.isDirty && isVirtualUri(document.uri)) return [];

		using scope = startLogScope(
			`${getLoggableName(this)}.provideCodeLenses(${Logger.toLoggable(document)})`,
			false,
		);

		const trackedDocument = await this.container.documentTracker.getOrAdd(document);
		const status = await trackedDocument.getStatus();
		if (!status.blameable) return [];

		let dirty = false;
		// Only allow dirty blames if we are idle
		if (document.isDirty && !status.dirtyIdle) {
			dirty = true;
		}

		const cfg = configuration.get('codeLens', document);
		let languageScope = { ...cfg.scopesByLanguage?.find(ll => ll.language?.toLowerCase() === document.languageId) };
		if (languageScope == null) {
			languageScope = {
				language: document.languageId,
			};
		}
		if (languageScope.scopes == null) {
			languageScope.scopes = cfg.scopes;
		}
		if (languageScope.symbolScopes == null) {
			languageScope.symbolScopes = cfg.symbolScopes;
		}

		languageScope.symbolScopes =
			languageScope.symbolScopes != null
				? (languageScope.symbolScopes = languageScope.symbolScopes.map(s => s.toLowerCase()))
				: [];

		const lenses: CodeLens[] = [];

		const gitUri = trackedDocument.uri;
		let blame: GitBlame | undefined;
		let symbols;

		if (!dirty) {
			if (token.isCancellationRequested) return lenses;

			if (languageScope.scopes.length === 1 && languageScope.scopes.includes('document')) {
				blame = await this.container.git.getBlame(gitUri, document);
			} else {
				[blame, symbols] = await Promise.all([
					this.container.git.getBlame(gitUri, document),
					executeCoreCommand<[Uri], SymbolInformation[]>(
						'vscode.executeDocumentSymbolProvider',
						document.uri,
					),
				]);
			}

			if (blame == null || blame?.lines.length === 0) return lenses;
		} else if (languageScope.scopes.length !== 1 || !languageScope.scopes.includes('document')) {
			let tracked;
			[tracked, symbols] = await Promise.all([
				this.container.git.isTracked(gitUri),
				executeCoreCommand<[Uri], SymbolInformation[]>('vscode.executeDocumentSymbolProvider', document.uri),
			]);

			if (!tracked) return lenses;
		}

		if (token.isCancellationRequested) return lenses;

		const documentRangeFn = once(() => document.validateRange(new Range(0, 0, 1000000, 1000000)));

		// Since blame information isn't valid when there are unsaved changes -- update the lenses appropriately
		const dirtyCommand: Command | undefined = dirty
			? { command: undefined!, title: this.getDirtyTitle(cfg) }
			: undefined;

		if (symbols !== undefined) {
			Logger.log(scope, `${symbols.length} symbol(s) found`);
			for (const sym of symbols) {
				this.provideCodeLens(
					lenses,
					document,
					sym,
					languageScope as Required<CodeLensLanguageScope>,
					documentRangeFn,
					blame,
					gitUri,
					cfg,
					dirty,
					dirtyCommand,
				);
			}
		}

		if (
			(languageScope.scopes.includes('document') || languageScope.symbolScopes.includes('file')) &&
			!languageScope.symbolScopes.includes('!file')
		) {
			// Check if we have a lens for the whole document -- if not add one
			if (lenses.find(l => l.range.start.line === 0 && l.range.end.line === 0) == null) {
				const blameRange = documentRangeFn();

				let blameForRangeFn: (() => GitBlame | undefined) | undefined = undefined;
				if (dirty || cfg.recentChange.enabled) {
					if (!dirty) {
						blameForRangeFn = once(() => this.container.git.getBlameRange(blame!, gitUri, blameRange));
					}

					const fileSymbol = new SymbolInformation(
						gitUri.fileName,
						SymbolKind.File,
						'',
						new Location(gitUri.documentUri(), new Range(0, 0, 0, blameRange.start.character)),
					);
					lenses.push(
						new GitRecentChangeCodeLens(
							document.languageId,
							fileSymbol,
							gitUri,
							cfg.dateFormat,
							blameForRangeFn,
							blameRange,
							true,
							getRangeFromSymbol(fileSymbol),
							cfg.recentChange.command,
							dirtyCommand,
						),
					);
				}
				if (!dirty && cfg.authors.enabled) {
					if (blameForRangeFn === undefined) {
						blameForRangeFn = once(() => this.container.git.getBlameRange(blame!, gitUri, blameRange));
					}

					const fileSymbol = new SymbolInformation(
						gitUri.fileName,
						SymbolKind.File,
						'',
						new Location(gitUri.documentUri(), new Range(0, 1, 0, blameRange.start.character)),
					);
					lenses.push(
						new GitAuthorsCodeLens(
							document.languageId,
							fileSymbol,
							gitUri,
							blameForRangeFn,
							blameRange,
							true,
							getRangeFromSymbol(fileSymbol),
							cfg.authors.command,
						),
					);
				}
			}
		}

		return lenses;
	}

	private getValidateSymbolRange(
		symbol: SymbolInformation | DocumentSymbol,
		languageScope: Required<CodeLensLanguageScope>,
		documentRangeFn: () => Range,
		includeSingleLineSymbols: boolean,
	): Range | undefined {
		let valid = false;
		let range: Range | undefined;

		const symbolName = SymbolKind[symbol.kind].toLowerCase();
		switch (symbol.kind) {
			case SymbolKind.File:
				if (languageScope.scopes.includes('containers') || languageScope.symbolScopes.includes(symbolName)) {
					valid = !languageScope.symbolScopes.includes(`!${symbolName}`);
				}

				if (valid) {
					// Adjust the range to be for the whole file
					range = documentRangeFn();
				}
				break;

			case SymbolKind.Package:
				if (languageScope.scopes.includes('containers') || languageScope.symbolScopes.includes(symbolName)) {
					valid = !languageScope.symbolScopes.includes(`!${symbolName}`);
				}

				if (valid) {
					// Adjust the range to be for the whole file
					range = getRangeFromSymbol(symbol);
					if (range.start.line === 0 && range.end.line === 0) {
						range = documentRangeFn();
					}
				}
				break;

			case SymbolKind.Class:
			case SymbolKind.Interface:
			case SymbolKind.Module:
			case SymbolKind.Namespace:
			case SymbolKind.Struct:
				if (languageScope.scopes.includes('containers') || languageScope.symbolScopes.includes(symbolName)) {
					range = getRangeFromSymbol(symbol);
					valid =
						!languageScope.symbolScopes.includes(`!${symbolName}`) &&
						(includeSingleLineSymbols || !range.isSingleLine);
				}
				break;

			case SymbolKind.Constructor:
			case SymbolKind.Enum:
			case SymbolKind.Function:
			case SymbolKind.Method:
			case SymbolKind.Property:
				if (languageScope.scopes.includes('blocks') || languageScope.symbolScopes.includes(symbolName)) {
					range = getRangeFromSymbol(symbol);
					valid =
						!languageScope.symbolScopes.includes(`!${symbolName}`) &&
						(includeSingleLineSymbols || !range.isSingleLine);
				}
				break;

			case SymbolKind.String:
				if (
					languageScope.symbolScopes.includes(symbolName) ||
					// A special case for markdown files, SymbolKind.String seems to be returned for headers, so consider those containers
					(languageScope.language === 'markdown' && languageScope.scopes.includes('containers'))
				) {
					range = getRangeFromSymbol(symbol);
					valid =
						!languageScope.symbolScopes.includes(`!${symbolName}`) &&
						(includeSingleLineSymbols || !range.isSingleLine);
				}
				break;

			default:
				if (languageScope.symbolScopes.includes(symbolName)) {
					range = getRangeFromSymbol(symbol);
					valid =
						!languageScope.symbolScopes.includes(`!${symbolName}`) &&
						(includeSingleLineSymbols || !range.isSingleLine);
				}
				break;
		}

		return valid ? (range ?? getRangeFromSymbol(symbol)) : undefined;
	}

	private provideCodeLens(
		lenses: CodeLens[],
		document: TextDocument,
		symbol: SymbolInformation | DocumentSymbol,
		languageScope: Required<CodeLensLanguageScope>,
		documentRangeFn: () => Range,
		blame: GitBlame | undefined,
		gitUri: GitUri | undefined,
		cfg: CodeLensConfig,
		dirty: boolean,
		dirtyCommand: Command | undefined,
	): void {
		try {
			const blameRange = this.getValidateSymbolRange(
				symbol,
				languageScope,
				documentRangeFn,
				cfg.includeSingleLineSymbols,
			);
			if (blameRange === undefined) return;

			const line = document.lineAt(getRangeFromSymbol(symbol).start);
			// Make sure there is only 1 lens per line
			if (lenses.length && lenses[lenses.length - 1].range.start.line === line.lineNumber) return;

			// Anchor the CodeLens to the start of the line -- so that the range won't change with edits (otherwise the CodeLens will be removed and re-added)
			let startChar = 0;

			let blameForRangeFn: (() => GitBlame | undefined) | undefined;
			if (dirty || cfg.recentChange.enabled) {
				if (!dirty) {
					blameForRangeFn = once(() => this.container.git.getBlameRange(blame!, gitUri!, blameRange));
				}
				lenses.push(
					new GitRecentChangeCodeLens(
						document.languageId,
						symbol,
						gitUri,
						cfg.dateFormat,
						blameForRangeFn,
						blameRange,
						false,
						line.range.with(new Position(line.range.start.line, startChar)),
						cfg.recentChange.command,
						dirtyCommand,
					),
				);
				startChar++;
			}

			if (cfg.authors.enabled) {
				let multiline = !blameRange.isSingleLine;
				// HACK for Omnisharp, since it doesn't return full ranges
				if (!multiline && document.languageId === 'csharp') {
					switch (symbol.kind) {
						case SymbolKind.File:
							break;
						case SymbolKind.Package:
						case SymbolKind.Module:
						case SymbolKind.Namespace:
						case SymbolKind.Class:
						case SymbolKind.Interface:
						case SymbolKind.Constructor:
						case SymbolKind.Method:
						case SymbolKind.Function:
						case SymbolKind.Enum:
							multiline = true;
							break;
					}
				}

				if (multiline && !dirty) {
					if (blameForRangeFn === undefined) {
						blameForRangeFn = once(() => this.container.git.getBlameRange(blame!, gitUri!, blameRange));
					}
					lenses.push(
						new GitAuthorsCodeLens(
							document.languageId,
							symbol,
							gitUri,
							blameForRangeFn,
							blameRange,
							false,
							line.range.with(new Position(line.range.start.line, startChar)),
							cfg.authors.command,
						),
					);
				}
			}
		} finally {
			if (isDocumentSymbol(symbol)) {
				for (const child of symbol.children) {
					this.provideCodeLens(
						lenses,
						document,
						child,
						languageScope,
						documentRangeFn,
						blame,
						gitUri,
						cfg,
						dirty,
						dirtyCommand,
					);
				}
			}
		}
	}

	resolveCodeLens(lens: CodeLens, token: CancellationToken): CodeLens | Promise<CodeLens> {
		if (lens instanceof GitRecentChangeCodeLens) return this.resolveGitRecentChangeCodeLens(lens, token);
		if (lens instanceof GitAuthorsCodeLens) return this.resolveGitAuthorsCodeLens(lens, token);
		// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
		return Promise.reject<CodeLens>(undefined);
	}

	private resolveGitRecentChangeCodeLens(lens: GitRecentChangeCodeLens, _token: CancellationToken): CodeLens {
		const blame = lens.getBlame();
		if (blame == null) return applyCommandWithNoClickAction('Unknown, (Blame failed)', lens);

		const recentCommit = first(blame.commits.values());
		if (recentCommit == null) return applyCommandWithNoClickAction('Unknown, (Blame failed)', lens);

		// TODO@eamodio This is FAR too expensive, but this accounts for commits that delete lines -- is there another way?
		// if (lens.uri != null) {
		// 	const commit = await this.container.git.getCommitForFile(lens.uri.repoPath, lens.uri.fsPath, {
		// 		range: lens.blameRange,
		// 	});
		// 	if (
		// 		commit != null &&
		// 		commit.sha !== recentCommit.sha &&
		// 		commit.date.getTime() > recentCommit.date.getTime()
		// 	) {
		// 		recentCommit = commit;
		// 	}
		// }

		let title = `${recentCommit.author.name}, ${
			lens.dateFormat == null ? recentCommit.formattedDate : recentCommit.formatDate(lens.dateFormat)
		}`;
		if (configuration.get('debug')) {
			title += ` [${lens.languageId}: ${SymbolKind[lens.symbol.kind]}(${lens.range.start.character}-${
				lens.range.end.character
			}${
				(lens.symbol as SymbolInformation).containerName
					? `|${(lens.symbol as SymbolInformation).containerName}`
					: ''
			}), Lines (${lens.blameRange.start.line + 1}-${lens.blameRange.end.line + 1}), Commit (${
				recentCommit.shortSha
			})]`;
		}

		if (lens.desiredCommand === false) {
			return applyCommandWithNoClickAction(title, lens);
		}

		switch (lens.desiredCommand) {
			case 'gitlens.copyRemoteCommitUrl':
				return applyCopyOrOpenCommitOnRemoteCommand<GitRecentChangeCodeLens>(title, lens, recentCommit, true);
			case 'gitlens.copyRemoteFileUrl':
				return applyCopyOrOpenFileOnRemoteCommand<GitRecentChangeCodeLens>(title, lens, recentCommit, true);
			case 'gitlens.diffWithPrevious':
				return applyDiffWithPreviousCommand<GitRecentChangeCodeLens>(title, lens, recentCommit);
			case 'gitlens.openCommitOnRemote':
				return applyCopyOrOpenCommitOnRemoteCommand<GitRecentChangeCodeLens>(title, lens, recentCommit);
			case 'gitlens.openFileOnRemote':
				return applyCopyOrOpenFileOnRemoteCommand<GitRecentChangeCodeLens>(title, lens, recentCommit);
			case 'gitlens.revealCommitInView':
				return applyRevealCommitInViewCommand<GitRecentChangeCodeLens>(title, lens, recentCommit);
			case 'gitlens.showCommitsInView':
				return applyShowCommitsInViewCommand<GitRecentChangeCodeLens>(title, lens, blame, recentCommit);
			case 'gitlens.showQuickCommitDetails':
				return applyShowQuickCommitDetailsCommand<GitRecentChangeCodeLens>(title, lens, recentCommit);
			case 'gitlens.showQuickCommitFileDetails':
				return applyShowQuickCommitFileDetailsCommand<GitRecentChangeCodeLens>(title, lens, recentCommit);
			case 'gitlens.showQuickRepoHistory':
				return applyShowQuickCurrentBranchHistoryCommand<GitRecentChangeCodeLens>(title, lens);
			case 'gitlens.showQuickFileHistory':
				return applyShowQuickFileHistoryCommand<GitRecentChangeCodeLens>(title, lens);
			case 'gitlens.toggleFileBlame':
				return applyToggleFileBlameCommand<GitRecentChangeCodeLens>(title, lens);
			case 'gitlens.toggleFileChanges':
				return applyToggleFileChangesCommand<GitRecentChangeCodeLens>(title, lens, recentCommit);
			case 'gitlens.toggleFileChangesOnly':
				return applyToggleFileChangesCommand<GitRecentChangeCodeLens>(title, lens, recentCommit, true);
			case 'gitlens.toggleFileHeatmap':
				return applyToggleFileHeatmapCommand<GitRecentChangeCodeLens>(title, lens);
			default:
				return lens;
		}
	}

	private resolveGitAuthorsCodeLens(lens: GitAuthorsCodeLens, _token: CancellationToken): CodeLens {
		const blame = lens.getBlame();
		if (blame == null) return applyCommandWithNoClickAction('? authors (Blame failed)', lens);

		const count = blame.authors.size;
		const author = first(blame.authors.values())?.name ?? 'Unknown';
		const andOthers =
			count > 1 ? ` and ${pluralize('one other', count - 1, { only: true, plural: 'others' })}` : '';

		let title = `${pluralize('author', count, { zero: '?' })} (${author}${andOthers})`;
		if (configuration.get('debug')) {
			title += ` [${lens.languageId}: ${SymbolKind[lens.symbol.kind]}(${lens.range.start.character}-${
				lens.range.end.character
			}${
				(lens.symbol as SymbolInformation).containerName
					? `|${(lens.symbol as SymbolInformation).containerName}`
					: ''
			}), Lines (${lens.blameRange.start.line + 1}-${lens.blameRange.end.line + 1}), Authors (${join(
				map(blame.authors.values(), a => a.name),
				', ',
			)})]`;
		}

		if (lens.desiredCommand === false) {
			return applyCommandWithNoClickAction(title, lens);
		}

		const commit = find(blame.commits.values(), c => c.author.name === author) ?? first(blame.commits.values());
		if (commit == null) return applyCommandWithNoClickAction(title, lens);

		switch (lens.desiredCommand) {
			case 'gitlens.copyRemoteCommitUrl':
				return applyCopyOrOpenCommitOnRemoteCommand<GitAuthorsCodeLens>(title, lens, commit, true);
			case 'gitlens.copyRemoteFileUrl':
				return applyCopyOrOpenFileOnRemoteCommand<GitAuthorsCodeLens>(title, lens, commit, true);
			case 'gitlens.diffWithPrevious':
				return applyDiffWithPreviousCommand<GitAuthorsCodeLens>(title, lens, commit);
			case 'gitlens.openCommitOnRemote':
				return applyCopyOrOpenCommitOnRemoteCommand<GitAuthorsCodeLens>(title, lens, commit);
			case 'gitlens.openFileOnRemote':
				return applyCopyOrOpenFileOnRemoteCommand<GitAuthorsCodeLens>(title, lens, commit);
			case 'gitlens.revealCommitInView':
				return applyRevealCommitInViewCommand<GitAuthorsCodeLens>(title, lens, commit);
			case 'gitlens.showCommitsInView':
				return applyShowCommitsInViewCommand<GitAuthorsCodeLens>(title, lens, blame);
			case 'gitlens.showQuickCommitDetails':
				return applyShowQuickCommitDetailsCommand<GitAuthorsCodeLens>(title, lens, commit);
			case 'gitlens.showQuickCommitFileDetails':
				return applyShowQuickCommitFileDetailsCommand<GitAuthorsCodeLens>(title, lens, commit);
			case 'gitlens.showQuickRepoHistory':
				return applyShowQuickCurrentBranchHistoryCommand<GitAuthorsCodeLens>(title, lens);
			case 'gitlens.showQuickFileHistory':
				return applyShowQuickFileHistoryCommand<GitAuthorsCodeLens>(title, lens);
			case 'gitlens.toggleFileBlame':
				return applyToggleFileBlameCommand<GitAuthorsCodeLens>(title, lens);
			case 'gitlens.toggleFileChanges':
				return applyToggleFileChangesCommand<GitAuthorsCodeLens>(title, lens, commit);
			case 'gitlens.toggleFileChangesOnly':
				return applyToggleFileChangesCommand<GitAuthorsCodeLens>(title, lens, commit, true);
			case 'gitlens.toggleFileHeatmap':
				return applyToggleFileHeatmapCommand<GitAuthorsCodeLens>(title, lens);
			default:
				return lens;
		}
	}

	private getDirtyTitle(cfg: CodeLensConfig) {
		if (cfg.recentChange.enabled && cfg.authors.enabled) {
			return configuration.get('strings.codeLens.unsavedChanges.recentChangeAndAuthors');
		}
		if (cfg.recentChange.enabled) return configuration.get('strings.codeLens.unsavedChanges.recentChangeOnly');
		return configuration.get('strings.codeLens.unsavedChanges.authorsOnly');
	}
}

function applyDiffWithPreviousCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
	title: string,
	lens: T,
	commit: GitCommit | undefined,
): T {
	lens.command = createCommand<[undefined, DiffWithPreviousCommandArgs]>(
		'gitlens.diffWithPrevious',
		title,
		undefined,
		{
			commit: commit,
			uri: lens.uri!.toFileUri(),
		},
	);
	return lens;
}

function applyCopyOrOpenCommitOnRemoteCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
	title: string,
	lens: T,
	commit: GitCommit,
	clipboard: boolean = false,
): T {
	lens.command = createCommand<[OpenOnRemoteCommandArgs]>('gitlens.openOnRemote', title, {
		resource: {
			type: RemoteResourceType.Commit,
			sha: commit.sha,
		},
		repoPath: commit.repoPath,
		clipboard: clipboard,
	});
	return lens;
}

function applyCopyOrOpenFileOnRemoteCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
	title: string,
	lens: T,
	commit: GitCommit,
	clipboard: boolean = false,
): T {
	lens.command = createCommand<[OpenOnRemoteCommandArgs]>('gitlens.openOnRemote', title, {
		resource: {
			type: RemoteResourceType.Revision,
			fileName: commit.file?.path ?? '',
			sha: commit.sha,
		},
		repoPath: commit.repoPath,
		clipboard: clipboard,
	});
	return lens;
}

function applyRevealCommitInViewCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
	title: string,
	lens: T,
	commit: GitCommit | undefined,
): T {
	lens.command = createCommand<[Uri, ShowQuickCommitCommandArgs]>(
		commit?.isUncommitted ? ('' as CodeLensCommands) : 'gitlens.revealCommitInView',
		title,
		lens.uri!.toFileUri(),
		{
			commit: commit,
			sha: commit === undefined ? undefined : commit.sha,
		},
	);
	return lens;
}

function applyShowCommitsInViewCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
	title: string,
	lens: T,
	blame: GitBlame,
	commit?: GitCommit,
): T {
	let refs;
	if (commit === undefined) {
		refs = [...filterMap(blame.commits.values(), c => (c.isUncommitted ? undefined : c.ref))];
	} else {
		refs = [commit.ref];
	}

	lens.command = createCommand<[ShowCommitsInViewCommandArgs]>(
		refs.length === 0 ? ('' as GlCommands) : 'gitlens.showCommitsInView',
		title,
		{
			repoPath: blame.repoPath,
			refs: refs,
		},
	);
	return lens;
}

function applyShowQuickCommitDetailsCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
	title: string,
	lens: T,
	commit: GitCommit | undefined,
): T {
	lens.command = createCommand<[Uri, ShowQuickCommitCommandArgs]>(
		commit?.isUncommitted ? ('' as CodeLensCommands) : 'gitlens.showQuickCommitDetails',
		title,
		lens.uri!.toFileUri(),
		{
			commit: commit,
			sha: commit === undefined ? undefined : commit.sha,
		},
	);
	return lens;
}

function applyShowQuickCommitFileDetailsCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
	title: string,
	lens: T,
	commit: GitCommit | undefined,
): T {
	lens.command = createCommand<[Uri, ShowQuickCommitFileCommandArgs]>(
		commit?.isUncommitted ? ('' as CodeLensCommands) : 'gitlens.showQuickCommitFileDetails',
		title,
		lens.uri!.toFileUri(),
		{
			commit: commit,
			sha: commit === undefined ? undefined : commit.sha,
		},
	);
	return lens;
}

function applyShowQuickCurrentBranchHistoryCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
	title: string,
	lens: T,
): T {
	lens.command = createCommand<[Uri]>('gitlens.showQuickRepoHistory', title, lens.uri!.toFileUri());
	return lens;
}

function applyShowQuickFileHistoryCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
	title: string,
	lens: T,
): T {
	lens.command = createCommand<[Uri, ShowQuickFileHistoryCommandArgs]>(
		'gitlens.showQuickFileHistory',
		title,
		lens.uri!.toFileUri(),
		{
			range: lens.isFullRange ? undefined : lens.blameRange,
		},
	);
	return lens;
}

function applyToggleFileBlameCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
	title: string,
	lens: T,
): T {
	lens.command = createCommand<[Uri]>('gitlens.toggleFileBlame', title, lens.uri!.toFileUri());
	return lens;
}

function applyToggleFileChangesCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
	title: string,
	lens: T,
	commit: GitCommit,
	only?: boolean,
): T {
	lens.command = createCommand<[Uri, ToggleFileChangesAnnotationCommandArgs]>(
		'gitlens.toggleFileChanges',
		title,
		lens.uri!.toFileUri(),
		{
			type: 'changes',
			context: { sha: commit.sha, only: only, selection: false },
		},
	);
	return lens;
}

function applyToggleFileHeatmapCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
	title: string,
	lens: T,
): T {
	lens.command = createCommand<[Uri]>('gitlens.toggleFileHeatmap', title, lens.uri!.toFileUri());
	return lens;
}

function applyCommandWithNoClickAction<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
	title: string,
	lens: T,
): T {
	lens.command = {
		title: title,
		command: '',
	};
	return lens;
}

function getRangeFromSymbol(symbol: DocumentSymbol | SymbolInformation) {
	return isDocumentSymbol(symbol) ? symbol.range : symbol.location.range;
}

function isDocumentSymbol(symbol: DocumentSymbol | SymbolInformation): symbol is DocumentSymbol {
	return is<DocumentSymbol>(symbol, 'children');
}
