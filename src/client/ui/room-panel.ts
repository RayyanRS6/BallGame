import { PHASE_LOBBY, PHASE_MATCH_END, TEAM_BLUE, TEAM_RED, TEAM_SPECTATOR, type TeamId } from '../../shared/constants/game.ts';
import type { ClientControl, RoomInfo } from '../../shared/protocol/control.ts';
import type { RosterEntry } from '../../shared/types/index.ts';
import { teamPalette } from '../rendering/colors.ts';
import { button, h } from './dom.ts';
import { openModal } from './modal.ts';
import { roomSettingsForm } from './room-settings-form.ts';
import { toast } from './toast.ts';

export interface RoomPanelActions {
  send(msg: ClientControl): void;
  leave(): void;
  shareLink(): string;
  serverLabel(): string;
}

/**
 * Lobby / room management overlay: teams, spectators, host tools (start,
 * stop, bots, moving/kicking players, settings) and leave.
 */
export class RoomPanel {
  readonly root: HTMLDivElement;
  private actions: RoomPanelActions;
  private body: HTMLDivElement;
  private room: RoomInfo | null = null;
  private roster: RosterEntry[] = [];
  private hostId = 0;
  private myId = 0;
  private phase = PHASE_LOBBY as number;
  private container: HTMLElement;
  visible = false;

  constructor(container: HTMLElement, actions: RoomPanelActions) {
    this.actions = actions;
    this.container = container;
    this.body = h('div', { class: 'room-body' });
    this.root = h('div', { class: 'room-panel' }, this.body);
    container.append(this.root);
    this.setVisible(true);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.classList.toggle('hidden', !v);
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  update(room: RoomInfo, roster: RosterEntry[], hostId: number, myId: number, phase: number): void {
    const changed = room !== this.room || roster !== this.roster || hostId !== this.hostId || myId !== this.myId || phase !== this.phase;
    this.room = room;
    this.roster = roster;
    this.hostId = hostId;
    this.myId = myId;
    this.phase = phase;
    if (changed) this.render();
  }

  private get isHost(): boolean {
    return this.hostId === this.myId && this.myId !== 0;
  }

  private render(): void {
    const room = this.room;
    if (!room) return;
    const s = room.settings;
    const active = this.phase !== PHASE_LOBBY && this.phase !== PHASE_MATCH_END;
    const me = this.roster.find((p) => p.id === this.myId);
    const col = (team: TeamId, title: string) => {
      const members = this.roster.filter((p) => p.team === team);
      const pal = team === TEAM_SPECTATOR ? null : teamPalette(team);
      const full = team !== TEAM_SPECTATOR && members.length >= s.match.teamSize;
      const canJoin = me && me.team !== team && !full && (!active || s.allowTeamSwitchDuringMatch || this.isHost);
      return h(
        'div',
        { class: `team-col team-${team}` },
        h('div', { class: 'team-head', style: pal ? { borderColor: pal.fill, color: pal.fill } : {} }, title, team !== TEAM_SPECTATOR ? h('span', { class: 'muted' }, ` ${members.length}/${s.match.teamSize}`) : null),
        h('div', { class: 'chips' }, ...members.map((p) => this.chip(p))),
        canJoin ? button(team === TEAM_SPECTATOR ? 'Spectate' : `Join ${title}`, () => this.actions.send({ t: 'team', team }), 'btn small') : null,
        this.isHost && team !== TEAM_SPECTATOR && !full ? button('+ Bot', () => this.actions.send({ t: 'addBot', team: team as 1 | 2 }), 'btn small ghost') : null,
      );
    };

    const status = this.phase === PHASE_LOBBY ? 'Warm-up — waiting for the host to start' : active ? 'Match in progress' : 'Match finished';
    this.body.replaceChildren(
      h(
        'div',
        { class: 'room-header' },
        h('div', null, h('div', { class: 'room-name' }, s.name), h('div', { class: 'muted small' }, `${this.actions.serverLabel()} · ${status}`)),
        h(
          'div',
          { class: 'room-code' },
          h('span', { class: 'muted small' }, 'CODE'),
          h('span', { class: 'code' }, room.code),
          button('Copy link', () => {
            navigator.clipboard?.writeText(this.actions.shareLink()).then(
              () => toast('Invite link copied', 'success'),
              () => toast(this.actions.shareLink(), 'info', 8000),
            );
          }, 'btn small'),
        ),
      ),
      h('div', { class: 'teams' }, col(TEAM_RED, 'Red'), col(TEAM_SPECTATOR, 'Spectators'), col(TEAM_BLUE, 'Blue')),
      h(
        'div',
        { class: 'room-actions' },
        this.isHost
          ? active
            ? button('Stop match', () => this.actions.send({ t: 'stop' }), 'btn danger')
            : button('Start match', () => this.actions.send({ t: 'start' }), 'btn primary')
          : h('span', { class: 'muted small' }, this.hostId ? `Host: ${this.roster.find((p) => p.id === this.hostId)?.name ?? '—'}` : 'Auto-start room'),
        this.isHost ? button('Room settings', () => this.openSettings(active), 'btn') : null,
        h('span', { class: 'spacer' }),
        button('Back to game (Esc)', () => this.setVisible(false), 'btn ghost'),
        button('Leave room', () => this.actions.leave(), 'btn danger ghost'),
      ),
      h('div', { class: 'muted small room-meta' }, `${s.match.timeLimit ? `${s.match.timeLimit / 60} min` : 'Unlimited'} · ${s.match.scoreLimit ? `first to ${s.match.scoreLimit}` : 'no score limit'} · ${s.physicsPreset} physics · ${s.tickRate} Hz · ${s.hasPassword ? 'password protected' : 'open'} · ${s.isPublic ? 'public' : 'private'}`),
    );
  }

  private chip(p: RosterEntry): HTMLElement {
    const tags: string[] = [];
    if (p.isHost) tags.push('host');
    if (p.isBot) tags.push('bot');
    if (p.status === 'reconnecting') tags.push('reconnecting');
    if (p.status === 'ai') tags.push('AI');
    const chip = h(
      'div',
      { class: `chip${p.id === this.myId ? ' me' : ''}${p.status !== 'connected' ? ' dim' : ''}`, title: tags.join(', ') },
      h('span', { class: 'chip-avatar' }, p.avatar || p.name.slice(0, 1).toUpperCase()),
      h('span', { class: 'chip-name' }, p.name),
      p.isHost ? h('span', { class: 'chip-tag' }, '★') : null,
      !p.isBot ? h('span', { class: 'chip-ping' }, p.status === 'reconnecting' ? '…' : `${p.ping}ms`) : null,
    );
    if (this.isHost && p.id !== this.myId) {
      chip.classList.add('clickable');
      chip.addEventListener('click', () => this.playerMenu(p));
    }
    return chip;
  }

  private playerMenu(p: RosterEntry): void {
    const send = (msg: ClientControl) => {
      this.actions.send(msg);
      modal.close();
    };
    const modal = openModal(this.container, p.name, null, [
      { label: 'Move to Red', onClick: () => send({ t: 'team', team: TEAM_RED, playerId: p.id }) },
      { label: 'Move to Spectators', onClick: () => send({ t: 'team', team: TEAM_SPECTATOR, playerId: p.id }) },
      { label: 'Move to Blue', onClick: () => send({ t: 'team', team: TEAM_BLUE, playerId: p.id }) },
      p.isBot
        ? { label: 'Remove bot', danger: true, onClick: () => send({ t: 'removeBot', playerId: p.id }) }
        : { label: 'Kick', danger: true, onClick: () => send({ t: 'kick', playerId: p.id, ban: false }) },
      ...(p.isBot ? [] : [{ label: 'Ban', danger: true, onClick: () => send({ t: 'kick', playerId: p.id, ban: true }) }]),
      { label: 'Cancel', onClick: () => modal.close() },
    ]);
  }

  private openSettings(locked: boolean): void {
    if (!this.room) return;
    const form = roomSettingsForm(this.room.settings, { creating: false, locked });
    const modal = openModal(
      this.container,
      'Room settings',
      form.el,
      [
        {
          label: 'Apply',
          primary: true,
          onClick: () => {
            this.actions.send({ t: 'settings', room: form.value() });
            modal.close();
          },
        },
        { label: 'Cancel', onClick: () => modal.close() },
      ],
      { wide: true },
    );
  }

  destroy(): void {
    this.root.remove();
  }
}
