import { isDaemonOwnedChannel } from './daemonChannels';
import type { IpcMainInvokeEvent } from 'electron';

type PaneCommandObject = object;
export type PaneCommandValue = PaneCommandObject | string | number | boolean | null | undefined;

export type PaneCommandHandler<
  TArgs extends PaneCommandValue[] = PaneCommandValue[],
  TResult extends PaneCommandValue = PaneCommandValue,
> = (
  ...args: TArgs
) => Promise<TResult> | TResult;

type RegisteredPaneCommandHandler = {
  invoke(...args: PaneCommandValue[]): Promise<PaneCommandValue> | PaneCommandValue;
}['invoke'];

/** Who issued a command: the local socket or IPC, a paired user client, or a peer daemon. */
export type PaneCommandOrigin = 'local' | 'remote-user' | 'remote-peer';

export interface PaneCommandInvokeOptions {
  origin?: PaneCommandOrigin;
}

export interface PaneCommandChannelActivity {
  inFlight: number;
  lastFinishedAt: number | undefined;
}

interface ChannelOriginActivity {
  inFlight: number;
  lastFinishedAt?: number;
}

interface IpcMainHandleLike {
  handle(
    channel: string,
    listener: (_event: IpcMainInvokeEvent, ...args: PaneCommandValue[]) => Promise<PaneCommandValue> | PaneCommandValue,
  ): void;
}

export class PaneCommandRegistry {
  private readonly handlers = new Map<string, RegisteredPaneCommandHandler>();
  private readonly boundChannels = new Set<string>();
  private readonly activity = new Map<string, Map<PaneCommandOrigin, ChannelOriginActivity>>();

  constructor(private readonly now: () => number = Date.now) {}

  register<TArgs extends PaneCommandValue[], TResult extends PaneCommandValue>(
    channel: string,
    handler: PaneCommandHandler<TArgs, TResult>,
  ): void {
    if (!isDaemonOwnedChannel(channel)) {
      throw new Error(`Cannot register non-daemon-owned channel "${channel}" in PaneCommandRegistry`);
    }

    if (this.handlers.has(channel)) {
      throw new Error(`Pane daemon command "${channel}" is already registered`);
    }

    this.handlers.set(channel, handler);
  }

  has(channel: string): boolean {
    return this.handlers.has(channel);
  }

  listChannels(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async invoke(
    channel: string,
    args: readonly PaneCommandValue[] = [],
    options: PaneCommandInvokeOptions = {},
  ): Promise<PaneCommandValue> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`No Pane daemon command registered for channel "${channel}"`);
    }

    const activity = this.originActivity(channel, options.origin ?? 'local');
    activity.inFlight += 1;
    try {
      return await handler(...args);
    } finally {
      activity.inFlight -= 1;
      activity.lastFinishedAt = this.now();
    }
  }

  /** Calls to a channel now running, and when the last one ended, across the given origins. */
  getChannelActivity(channel: string, origins: readonly PaneCommandOrigin[]): PaneCommandChannelActivity {
    const byOrigin = this.activity.get(channel);
    let inFlight = 0;
    let lastFinishedAt: number | undefined;
    for (const origin of origins) {
      const activity = byOrigin?.get(origin);
      if (!activity) continue;
      inFlight += activity.inFlight;
      if (activity.lastFinishedAt !== undefined) {
        lastFinishedAt = Math.max(lastFinishedAt ?? 0, activity.lastFinishedAt);
      }
    }
    return { inFlight, lastFinishedAt };
  }

  private originActivity(channel: string, origin: PaneCommandOrigin): ChannelOriginActivity {
    let byOrigin = this.activity.get(channel);
    if (!byOrigin) {
      byOrigin = new Map();
      this.activity.set(channel, byOrigin);
    }
    let activity = byOrigin.get(origin);
    if (!activity) {
      activity = { inFlight: 0 };
      byOrigin.set(origin, activity);
    }
    return activity;
  }

  bindChannel(ipcMain: IpcMainHandleLike, channel: string): void {
    if (!this.handlers.has(channel)) {
      throw new Error(`Cannot bind unregistered Pane daemon command "${channel}"`);
    }

    if (this.boundChannels.has(channel)) {
      throw new Error(`Pane daemon command "${channel}" is already bound to IPC`);
    }

    ipcMain.handle(channel, (_event, ...args) => this.invoke(channel, args));
    this.boundChannels.add(channel);
  }

  bindChannels(ipcMain: IpcMainHandleLike, channels: readonly string[]): void {
    for (const channel of channels) {
      this.bindChannel(ipcMain, channel);
    }
  }
}
