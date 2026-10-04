import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import { Modal, ModalHeader } from './ui/Modal';
import { Button } from './ui/Button';
import { ConfirmDialog } from './ConfirmDialog';
import { SettingsLayout } from './settings/SettingsLayout';
import { GeneralSettings } from './settings/categories/GeneralSettings';
import { AppearanceSettings } from './settings/categories/AppearanceSettings';
import { TerminalSettings } from './settings/categories/TerminalSettings';
import { AIAgentsSettings } from './settings/categories/AIAgentsSettings';
import { WorktreesGitSettings } from './settings/categories/WorktreesGitSettings';
import { NotificationSettings } from './NotificationSettings';
import { RemoteAccessSettings } from './settings/categories/RemoteAccessSettings';
import { IntegrationsSettings } from './settings/categories/IntegrationsSettings';
import { ShortcutsSettings } from './settings/categories/ShortcutsSettings';
import { PrivacySettings } from './settings/categories/PrivacySettings';
import { AdvancedSettings } from './settings/categories/AdvancedSettings';
import { UsageSettings } from './settings/categories/UsageSettings';
import { RemoteAccessWorkflows } from './settings/RemoteAccessWorkflows';
import { useSettingsPersistence } from './settings/useSettingsPersistence';
import { useDirtySettingsForms } from './settings/useDirtySettingsForms';
import { useRemoteAccessSettings } from './settings/useRemoteAccessSettings';
import { SETTINGS_CATEGORIES, SETTINGS_CATEGORIES_WITHOUT_USAGE, settingDomId } from './settings/catalog';
import type {
  RemoteAccessSubviewId,
  SettingsCategoryId,
  SettingsOpenRequest,
  SettingsSettingId,
} from '../types/settings';
import type { VersionInfo } from '../types/session';
import { API } from '../utils/api';

/** Whether the host probe found a Codex login; the Usage tab is rendered only when 'available'. */
type CodexUsageDetection = 'unknown' | 'available' | 'unavailable';

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  category: SettingsCategoryId;
  onCategoryChange: (category: SettingsCategoryId) => void;
  openRequest?: SettingsOpenRequest;
  onOpenRequestHandled: () => void;
  onShowKeyboardShortcuts: () => void;
  onUpdate: (versionInfo: VersionInfo) => void;
  onSendFeedback: () => void;
}

/** How long an opened Settings link waits for its row to render. */
const SETTING_FOCUS_WAIT_MS = 5000;
/** Where the user types in a settings row: a text box, not its buttons, toggles or choices. */
const SETTING_TEXT_FIELD = 'textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])';

export function Settings({ isOpen, onClose, category, onCategoryChange, openRequest, onOpenRequestHandled, onShowKeyboardShortcuts, onUpdate, onSendFeedback }: SettingsProps) {
  const persistence = useSettingsPersistence(isOpen);
  const dirtyForms = useDirtySettingsForms();
  const {
    setDirty,
    requestTransition,
    confirmOpen,
    discardAndContinue,
    stay,
  } = dirtyForms;
  const [platform, setPlatform] = useState('darwin');
  const [systemMonoFonts, setSystemMonoFonts] = useState<string[]>([]);
  const [remoteSubview, setRemoteSubview] = useState<RemoteAccessSubviewId | undefined>();
  const [codexUsageDetection, setCodexUsageDetection] = useState<CodexUsageDetection>('unknown');
  const handledRequestRef = useRef<number | null>(null);
  const fontsLoadedRef = useRef(false);
  const remote = useRemoteAccessSettings(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return;
    void window.electronAPI.getPlatform().then(setPlatform);
    if (!fontsLoadedRef.current) {
      fontsLoadedRef.current = true;
      void window.electronAPI.config.getMonospaceFonts().then((response) => {
        if (response.success && Array.isArray(response.data)) {
          // SAFETY: The named IPC/API channel contract establishes this response payload type.
          setSystemMonoFonts(response.data as string[]);
        }
      }).catch(() => undefined);
    }
  }, [isOpen]);

  // Show the Usage tab when Codex transcripts have been indexed (rate limits exist).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void API.usage.getReport({ providers: ['codex'] }).then((response) => {
      if (cancelled) return;
      const hasLimits = response.success && (response.data?.rateLimits.length ?? 0) > 0;
      setCodexUsageDetection(hasLimits ? 'available' : 'unavailable');
    }).catch(() => {
      if (!cancelled) setCodexUsageDetection('unavailable');
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const visibleCategories = codexUsageDetection === 'available'
    ? SETTINGS_CATEGORIES
    : SETTINGS_CATEGORIES_WITHOUT_USAGE;

  // A remembered Usage category with no Codex login falls back to General.
  useEffect(() => {
    if (isOpen && category === 'usage' && codexUsageDetection === 'unavailable') onCategoryChange('general');
  }, [category, codexUsageDetection, isOpen, onCategoryChange]);

  // Some rows render only once their data loads (the cloud sandbox rows wait for the cloud
  // library), so wait for the row to appear rather than looking for it once.
  const stopFocusWaitRef = useRef<(() => void) | null>(null);
  const focusSetting = useCallback((setting?: SettingsSettingId) => {
    stopFocusWaitRef.current?.();
    stopFocusWaitRef.current = null;
    if (!setting) return;
    // The field the user came to fill in gets focus; a row without one is focused itself. A field that
    // is still disabled (its value loading) is waited for.
    const focus = (settle: boolean) => {
      const row = document.getElementById(settingDomId(setting));
      if (!row) return false;
      const field = row.querySelector<HTMLElement>(SETTING_TEXT_FIELD);
      if (field?.matches(':disabled') && !settle) return false;
      row.scrollIntoView({ block: 'center' });
      (field && !field.matches(':disabled') ? field : row).focus({ preventScroll: true });
      return true;
    };
    const observer = new MutationObserver(() => {
      if (focus(false)) stop();
    });
    const timeout = window.setTimeout(() => {
      focus(true);
      stop();
    }, SETTING_FOCUS_WAIT_MS);
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      if (stopFocusWaitRef.current === stop) stopFocusWaitRef.current = null;
    };
    stopFocusWaitRef.current = stop;
    // The category switch renders first; a row already there is focused on the next frame.
    window.requestAnimationFrame(() => {
      if (stopFocusWaitRef.current !== stop) return;
      if (focus(false)) stop();
      else observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    });
  }, []);

  useEffect(() => () => stopFocusWaitRef.current?.(), []);

  useEffect(() => {
    if (!isOpen || !openRequest || handledRequestRef.current === openRequest.nonce) return;
    handledRequestRef.current = openRequest.nonce;
    requestTransition(() => {
      onCategoryChange(openRequest.target.category);
      setRemoteSubview(openRequest.target.subview);
      focusSetting(openRequest.target.setting);
    });
    onOpenRequestHandled();
  }, [focusSetting, isOpen, onCategoryChange, onOpenRequestHandled, openRequest, requestTransition]);

  const changeCategory = useCallback((nextCategory: SettingsCategoryId) => {
    if (nextCategory === category && !remoteSubview) return;
    requestTransition(() => {
      setRemoteSubview(undefined);
      onCategoryChange(nextCategory);
    });
  }, [category, onCategoryChange, remoteSubview, requestTransition]);

  const requestClose = useCallback(() => {
    requestTransition(() => {
      setRemoteSubview(undefined);
      onClose();
    });
  }, [onClose, requestTransition]);

  const showKeyboardShortcuts = useCallback(() => {
    requestTransition(onShowKeyboardShortcuts);
  }, [onShowKeyboardShortcuts, requestTransition]);

  const showUpdate = useCallback((versionInfo: VersionInfo) => {
    requestTransition(() => {
      setRemoteSubview(undefined);
      onClose();
      onUpdate(versionInfo);
    });
  }, [onClose, onUpdate, requestTransition]);

  const openRemoteSubview = useCallback((subview: RemoteAccessSubviewId) => {
    requestTransition(() => setRemoteSubview(subview));
  }, [requestTransition]);

  const content = () => {
    if (!persistence.config) return null;
    const sharedDirtyProps = { onDirtyChange: setDirty };
    switch (category) {
      case 'general':
        // onSendFeedback is passed straight through, unlike showUpdate/showKeyboardShortcuts:
        // the feedback dialog stacks on top of Settings instead of replacing it, so there is
        // no transition to guard and closing Settings would strand focus on an unmounted button.
        return <GeneralSettings persistence={persistence} onUpdate={showUpdate} onSendFeedback={onSendFeedback} />;
      case 'appearance':
        return <AppearanceSettings persistence={persistence} />;
      case 'terminal':
        return <TerminalSettings persistence={persistence} systemMonoFonts={systemMonoFonts} />;
      case 'ai-agents':
        return <AIAgentsSettings persistence={persistence} {...sharedDirtyProps} />;
      case 'usage':
        return <UsageSettings />;
      case 'worktrees-git':
        return <WorktreesGitSettings persistence={persistence} {...sharedDirtyProps} />;
      case 'notifications':
        return <NotificationSettings persistence={persistence} />;
      case 'remote-access':
        return remoteSubview
          ? <RemoteAccessWorkflows subview={remoteSubview} controller={remote} onBack={() => requestTransition(() => setRemoteSubview(undefined))} {...sharedDirtyProps} />
          : <RemoteAccessSettings controller={remote} onOpenSubview={openRemoteSubview} />;
      case 'integrations':
        return <IntegrationsSettings persistence={persistence} {...sharedDirtyProps} />;
      case 'shortcuts':
        return <ShortcutsSettings persistence={persistence} onShowKeyboardShortcuts={showKeyboardShortcuts} {...sharedDirtyProps} />;
      case 'privacy':
        return <PrivacySettings persistence={persistence} />;
      case 'advanced':
        return <AdvancedSettings persistence={persistence} platform={platform} {...sharedDirtyProps} />;
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={requestClose}
        size="full"
        showCloseButton={false}
        className="mx-auto h-[calc(100vh-4rem)] min-h-[560px] max-h-[760px] max-w-6xl"
      >
        <ModalHeader title="Pane Settings" icon={<SettingsIcon className="h-5 w-5" />} onClose={requestClose} />
        {persistence.isLoading && !persistence.config ? (
          <div className="flex min-h-[420px] items-center justify-center text-sm text-text-tertiary" aria-live="polite">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Loading settings
          </div>
        ) : persistence.configError && !persistence.config ? (
          <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 p-6 text-center">
            <AlertCircle className="h-6 w-6 text-status-error" />
            <p className="max-w-md text-sm text-status-error" role="alert">{persistence.configError}</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void persistence.fetchConfig()}>Retry</Button>
          </div>
        ) : (
          <SettingsLayout category={category} categories={visibleCategories} onCategoryChange={changeCategory}>
            {content()}
          </SettingsLayout>
        )}
      </Modal>
      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={stay}
        onConfirm={discardAndContinue}
        title="Discard unsaved changes?"
        message="This form has changes that have not been applied. Discard them and continue?"
        confirmText="Discard Changes"
        cancelText="Stay"
        variant="warning"
      />
    </>
  );
}
