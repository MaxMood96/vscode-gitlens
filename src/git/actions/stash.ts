import type { Uri } from 'vscode';
import type { PushFlags } from '../../commands/git/stash';
import { Container } from '../../container';
import type { ViewNode } from '../../views/nodes/abstract/viewNode';
import type { RevealOptions } from '../../views/viewBase';
import { executeGitCommand } from '../actions';
import type { GitStashCommit } from '../models/commit';
import type { GitStashReference } from '../models/reference';
import type { Repository } from '../models/repository';

export function apply(repo?: string | Repository, ref?: GitStashReference): Promise<void> {
	return executeGitCommand({
		command: 'stash',
		state: { subcommand: 'apply', repo: repo, reference: ref },
	});
}

export function drop(repo?: string | Repository, refs?: GitStashReference[]): Promise<void> {
	return executeGitCommand({
		command: 'stash',
		state: { subcommand: 'drop', repo: repo, references: refs },
	});
}

export function rename(repo?: string | Repository, ref?: GitStashReference, message?: string): Promise<void> {
	return executeGitCommand({
		command: 'stash',
		state: { subcommand: 'rename', repo: repo, reference: ref, message: message },
	});
}

export function pop(repo?: string | Repository, ref?: GitStashReference): Promise<void> {
	return executeGitCommand({
		command: 'stash',
		state: { subcommand: 'pop', repo: repo, reference: ref },
	});
}

export function push(
	repo?: string | Repository,
	uris?: Uri[],
	message?: string,
	includeUntracked: boolean = false,
	keepStaged: boolean = false,
	onlyStaged: boolean = false,
	onlyStagedUris?: Uri[],
): Promise<void> {
	return executeGitCommand({
		command: 'stash',
		state: {
			subcommand: 'push',
			repo: repo,
			uris: uris,
			onlyStagedUris: onlyStagedUris,
			message: message,
			flags: [
				...(includeUntracked ? ['--include-untracked'] : []),
				...(keepStaged ? ['--keep-index'] : []),
				...(onlyStaged ? ['--staged'] : []),
			] as PushFlags[],
		},
	});
}

export function revealStash(stash: GitStashReference, options?: RevealOptions): Promise<ViewNode | undefined> {
	return Container.instance.views.revealStash(stash, options);
}

export function showStashInDetailsView(
	stash: GitStashReference | GitStashCommit,
	options?: { pin?: boolean; preserveFocus?: boolean },
): Promise<void> {
	const { preserveFocus, ...opts } = { ...options, commit: stash };
	return Container.instance.views.commitDetails.show({ preserveFocus: preserveFocus }, opts);
}
