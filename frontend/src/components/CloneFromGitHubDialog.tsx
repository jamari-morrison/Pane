import { useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { EnhancedInput } from './ui/EnhancedInput';
import { FieldWithTooltip } from './ui/FieldWithTooltip';
import { API } from '../utils/api';
import { useNavigationStore } from '../stores/navigationStore';
import { useCloneDraftStore } from '../stores/cloneDraftStore';
import { useRemoteRuntimeState } from '../hooks/useRemoteRuntimeState';
import { openHostTerminal } from '../utils/hostTerminal';
import { CloneSignInNotice } from './CloneSignInNotice';
import { GIT_CLONE_AUTH_REQUIRED } from '../../../shared/types/gitClone';

/** Typed into the host terminal for the user to run; never submitted for them. */
const GITHUB_SIGN_IN_COMMAND = 'gh auth login --web --git-protocol https && gh auth setup-git';

interface CloneFromGitHubDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

export function CloneFromGitHubDialog({ isOpen, onClose }: CloneFromGitHubDialogProps) {
  const { url, destPath, error, signInHost, update: updateDraft, reset: resetDraft } = useCloneDraftStore();
  const [cloning, setCloning] = useState(false);
  const [terminalError, setTerminalError] = useState('');
  const { connectionState } = useRemoteRuntimeState();

  const navigateToProject = useNavigationStore(s => s.navigateToProject);

  const setDestPath = (value: string) => updateDraft({ destPath: value });
  const setError = (value: string) => updateDraft({ error: value, signInHost: null });

  const resetAndClose = () => {
    resetDraft();
    setCloning(false);
    setTerminalError('');
    onClose();
  };

  // Closes without clearing the draft, so the user can come back and try again.
  const handleOpenTerminal = async () => {
    if (!signInHost) return;
    setTerminalError('');
    try {
      await openHostTerminal({ input: GITHUB_SIGN_IN_COMMAND });
      onClose();
    } catch (err) {
      setTerminalError(err instanceof Error ? err.message : `Could not open the terminal on ${signInHost}`);
    }
  };

  const handleBrowse = async () => {
    const result = await window.electronAPI.dialog.openDirectory();
    if (result.success && result.data) {
      setDestPath(result.data);
    }
  };

  const handleClone = async () => {
    if (!url || !destPath) return;
    setCloning(true);
    setTerminalError('');
    // A sign-in notice stays up while its Try again runs.
    updateDraft({ error: '' });
    try {
      const cloneResult = await API.git.cloneRepo(url, destPath);
      if (!cloneResult.success || !cloneResult.data) {
        const remoteHost = connectionState.mode === 'remote' ? connectionState.activeProfileLabel : null;
        updateDraft({
          error: cloneResult.error ?? 'Clone failed',
          signInHost: cloneResult.code === GIT_CLONE_AUTH_REQUIRED ? remoteHost : null,
        });
        setCloning(false);
        return;
      }

      const { clonedPath, repoName } = cloneResult.data;

      const projectResult = await API.projects.create({
        name: repoName,
        path: clonedPath,
        active: false,
      });

      if (!projectResult.success || !projectResult.data) {
        setError(projectResult.error ?? 'Failed to create project');
        setCloning(false);
        return;
      }

      window.dispatchEvent(new Event('project-changed'));
      navigateToProject(projectResult.data.id);
      resetAndClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      setCloning(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={resetAndClose} size="lg">
      <ModalHeader
        title="Clone from GitHub"
        icon={<GitHubIcon className="w-5 h-5" />}
      />
      <ModalBody>
        <div className="space-y-6">
          <FieldWithTooltip
            label="Repository URL"
            tooltip="The HTTPS or SSH URL of the GitHub repository to clone"
          >
            <EnhancedInput
              type="text"
              value={url}
              onChange={(e) => {
                updateDraft({ url: e.target.value, error: '', signInHost: null });
              }}
              placeholder="https://github.com/user/repo"
              size="lg"
              fullWidth
            />
          </FieldWithTooltip>

          <FieldWithTooltip
            label="Destination"
            tooltip="The local directory where the repository will be cloned into"
          >
            <div className="space-y-2">
              <EnhancedInput
                type="text"
                value={destPath}
                readOnly
                placeholder="Select a destination folder..."
                size="lg"
                fullWidth
              />
              <div className="flex justify-end">
                <Button onClick={handleBrowse} variant="secondary" size="sm">
                  Browse
                </Button>
              </div>
            </div>
          </FieldWithTooltip>

          {signInHost ? (
            <CloneSignInNotice
              host={signInHost}
              retrying={cloning}
              onOpenTerminal={() => void handleOpenTerminal()}
              onTryAgain={() => void handleClone()}
            />
          ) : error && (
            <div className="text-sm text-status-error">{error}</div>
          )}
          {terminalError && (
            <div className="text-sm text-status-error">{terminalError}</div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button onClick={resetAndClose} variant="ghost" size="md">
          Cancel
        </Button>
        <Button
          onClick={handleClone}
          variant="primary"
          size="md"
          loading={cloning}
          loadingText="Cloning..."
          disabled={!url || !destPath}
        >
          Clone
        </Button>
      </ModalFooter>
    </Modal>
  );
}
