/** Browser regression check using the real render functions, without joining a server.
 * Run: npx tsx packages/web/scripts/channel-presence-check.ts
 * Requires Playwright's Chromium, or the installed Edge on Windows.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chromium } from 'playwright-core';
import { ClientFlags, ChannelFlags, Group, PermissionAction } from '../../protocol/src/types.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
function functions(path: string, names: string[]): string {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
  return names.map((name) => {
    const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, `Missing real renderer: ${name}`);
    return declaration.getText(source).replace(/^export /, '');
  }).join('\n');
}
const renderers = functions('src/main.ts', [
  'renderChannelBranch', 'renderChannelTree', 'renderSectionHeader', 'renderToolRows', 'renderToolRow',
  'isBotChannel', 'currentMainOf', 'playerInfoFor', 'isScreenSharedBy', 'appendScreenIndicator',
  'renderProfileAvatar', 'renderMemberDetail', 'selectMember', 'renderPeer', 'renderChannelInfoPanel', 'appendChannelTopic', 'updateMemberSpeakingIndicators',
  'renderClientDescriptionEditor',
  'renderUserProfileCard', 'renderClientInfoPanel', 'formatDuration',
]) + functions('src/profile-editor.ts', ['renderProfileCover']);
const setup = `
const ClientFlags = ${JSON.stringify(ClientFlags)}, ChannelFlags = ${JSON.stringify(ChannelFlags)}, Group = ${JSON.stringify(Group)};
const PermissionAction = ${JSON.stringify(PermissionAction)};
const DEFAULT_PROFILE_ACCENT = '#9273e8', t = s => s;
const $ = (tag, cls) => { const el = document.createElement(tag); if (cls) el.className = cls; return el; };
const text = (tag, cls, content) => { const el = $(tag, cls); el.textContent = content; return el; };
const serverAssetUrl = () => 'data:image/png;base64,invalid';
let selectedChannelId = 1, selectedClientId = 0, selectedTool = null;
let renders = 0, openedDm = 0, menuClient = 0;
const render = () => { renders++; };
const showUserMenu = (el, c) => { menuClient = c.id; };
const showChannelMenu = () => {};
const collapsedChannels = new Set(), BOT_CHANNEL_NAMES = new Set();
const channels = [
  { id: 1, parentId: 0, name: 'Lobby · ponto de encontro', topic: 'A party começa aqui.', flags: ChannelFlags.Default, maxClients: 12 },
  { id: 2, parentId: 0, name: 'Hunt · Soul War', topic: 'Organizando a próxima hunt', flags: ChannelFlags.Password, maxClients: 5 },
  { id: 3, parentId: 2, name: 'Suporte da party', topic: '', flags: ChannelFlags.Moderated, maxClients: 0 },
  { id: 4, parentId: 0, name: 'Sala de descanso', topic: '', flags: ChannelFlags.VoiceDisabled, maxClients: 0 },
];
const members = [
  { id: 1, nickname: 'PEDRAO', group: Group.Dono, flags: 0, description: 'Main: Pedro Knight' },
  { id: 2, nickname: 'psikin', group: Group.Member, flags: 0, description: 'Main: Psikin Druid' },
  { id: 3, nickname: 'convidado com apelido muito comprido', group: Group.Guest, flags: ClientFlags.MutedMic | ClientFlags.Away, description: 'Main: Ancient Sorcerer With A Long Name' },
  { id: 4, nickname: 'manowar', group: Group.Admin, flags: ClientFlags.NoInput, description: '' },
  { id: 5, nickname: 'frost', group: Group.Member, flags: 0, description: '' },
].map(c => ({ ...c, fingerprint: String(c.id), channelId: 1, connectedAt: Date.now() }));
const profiles = [
  { accent: '#bb8ef5', border: 'royal', bannerStyle: 'orbit', statusText: 'Bora fechar a party?' },
  { accent: '#5ad6b4', border: 'signal', bannerStyle: 'aurora', statusText: 'Healer da party' },
  { accent: '#e5a268', border: 'ember', bannerStyle: 'sunset', statusText: 'Um recado muito longo para verificar os limites da interface' },
  { accent: '#6dc7e0', border: 'frost', bannerStyle: 'grid', statusText: 'Organizando a próxima hunt' },
  { accent: '#aaa', border: 'none', bannerStyle: 'solid', statusText: '' },
];
profiles[3].avatar = 'data:image/png;base64,invalid';
profiles[3].banner = 'data:image/png;base64,invalid';
const client = {
  myGroup: Group.Guest, descriptionMinGroup: Group.Moderator,
  permissionFor() { return this.descriptionMinGroup; },
  setClientDescription(fingerprint, description) { window.savedDescription = { fingerprint, description }; },
  userVolume: () => 1, isUserMuted: () => false,
  selfId: 1, self: members[0], channels: new Map(channels.map(c => [c.id, c])), clients: new Map(members.map(c => [c.id,c])), claims: new Map(),
  playerInfos: new Map([
    ['1', { name: 'Pedro Knight', vocation: 'Elite Knight', level: 842, online: true }],
    ['2', { name: 'Psikin Druid', vocation: 'Elder Druid', level: 715, online: true }],
    ['3', { name: 'Ancient Sorcerer With A Long Name', vocation: 'Master Sorcerer', level: 1032, online: false }],
  ]),
  talking: new Set([2]), isTalking(id) { return this.talking.has(id); },
  screen: { isLive: id => id === 2 }, profileFor: c => profiles[c.id - 1],
  groupDef: group => ({ name: group === Group.Dono ? 'Dono' : group === Group.Admin ? 'Admin' : group === Group.Member ? 'Membro' : 'Visitante', icon: '', color: '' }),
  canMove: () => false, canMoveChannel: () => false,
  membersOf: id => members.filter(c => c.channelId === id), childrenOf: id => channels.filter(c => c.parentId === id),
  openDm: id => { openedDm = id; }, setNickname: name => { members[0].nickname = name; }, join: id => { window.joined = id; },
};
`;
const mount = `
const tree = document.querySelector('.tree');
renderChannelTree(tree, 0, 0);
document.querySelector('#overview').append(renderChannelInfoPanel(channels[0]));
updateMemberSpeakingIndicators();
window.fixture = { client, members, profiles, channels, renderPeer, renderChannelInfoPanel,
  renderClientDescriptionEditor,
  renderClientInfoPanel, renderUserProfileCard,
  updateMemberSpeakingIndicators,
  selection: () => ({ selectedClientId, selectedChannelId, renders, openedDm, menuClient }) };
`;
const script = ts.transpileModule(setup + renderers + mount, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const css = read('../ui/tokens.css') + read('src/style.css').replace("@import '@vox/ui/tokens.css';", '') + read('src/profile-studio.css') + read('src/channel-presence.css');
const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>v0x · Prévia dos canais</title><style>${css}
body { padding: 24px; overflow: auto; } .preview { max-width: 1180px; margin: auto; }
.preview-note { font: 10px var(--mono); color: var(--amber); letter-spacing: .12em; margin-bottom: 18px; }
.preview-layout { display: grid; grid-template-columns: 340px minmax(0,1fr); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; min-height: 650px; }
.preview .rooms { grid-area: auto; width: auto; min-width: 0; } .preview #overview { min-width: 0; } .preview .channel-info { max-height: none; }
.preview .rooms > header { padding: 18px; } .preview .tree { overflow: visible; }
@media(max-width: 640px) { body { padding: 10px; } .preview-layout { grid-template-columns: minmax(0,1fr); } }
</style><body><div class="preview"><div class="preview-note">PRÉVIA LOCAL · DADOS DE DEMONSTRAÇÃO</div><div class="preview-layout"><aside class="rooms"><header><strong>polakux</strong><div class="rooms-presence">5 membros · sua comunidade</div></header><div class="tree"></div></aside><main id="overview"></main></div></div><script>${script}</script></body></html>`;
const out = mkdtempSync(join(tmpdir(), 'vox-channel-preview-'));
writeFileSync(join(out, 'preview.html'), html);
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(html);
  assert.equal(await page.locator('.peer').count(), 5);
  assert.equal(await page.locator('.channel-member-card').count(), 5);
  assert.equal(await page.locator('.peer .member-live').count(), 1);
  assert.equal(await page.locator('.peer').nth(1).locator('.member-detail-copy').textContent(), 'Psikin Druid');
  assert.equal(await page.locator('.channel-member-card').nth(3).locator('.profile-avatar-empty').count(), 1);
  assert.equal(await page.locator('.channel-member-card').nth(3).locator('.has-image').count(), 0);
  assert.equal(await page.locator('[data-speaking-avatar="2"].talking').count(), 2);
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.client.talking.clear();
    f.updateMemberSpeakingIndicators();
  });
  assert.equal(await page.locator('[data-speaking-avatar].talking, [data-vu].live').count(), 0);
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.client.talking.add(2);
    f.updateMemberSpeakingIndicators();
  });
  for (const width of [1280, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Page overflow at ${width}`);
    assert.ok(await page.locator('.peer, .channel-member-card').evaluateAll(nodes => nodes.every(el => el.scrollWidth <= el.clientWidth + 1)), `Member overflow at ${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.screenshot({ path: join(out, 'channels-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(out, 'channels-mobile.png'), fullPage: true });
  await page.locator('.channel-member-card').nth(1).click();
  assert.equal(await page.evaluate(() => (window as any).fixture.selection().selectedClientId), 2);
  await page.locator('.peer').nth(3).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => (window as any).fixture.selection().selectedClientId), 4);
  await page.locator('.peer').nth(1).dblclick();
  assert.equal(await page.evaluate(() => (window as any).fixture.selection().openedDm), 2);
  await page.locator('.peer').nth(1).click({ button: 'right' });
  assert.equal(await page.evaluate(() => (window as any).fixture.selection().menuClient), 2);
  await page.locator('.peer .nick').first().dblclick();
  await page.locator('.peer .nick input').fill('Novo apelido');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => (window as any).fixture.members[0].nickname), 'Novo apelido');
  await page.evaluate(() => {
    const f = (window as any).fixture;
    document.querySelector('#overview')!.replaceChildren(f.renderChannelInfoPanel(f.channels[1]));
  });
  assert.equal(await page.locator('.channel-members-empty').count(), 1);
  await page.locator('#overview .primary').click();
  assert.equal(await page.evaluate(() => (window as any).joined), 2);
  const disclosure = page.locator('.channel-row[data-channel-id="2"] .room-disclosure');
  await disclosure.click();
  // The fixture deliberately does not run the full app render loop.
  await page.evaluate(() => {
    const tree = document.querySelector('.tree')!;
    tree.replaceChildren();
    (window as any).eval('renderChannelTree(document.querySelector(".tree"), 0, 0)');
  });
  assert.equal(await page.locator('.channel-row[data-channel-id="3"]').count(), 0);
  assert.equal(await page.locator('.channel-row[data-channel-id="2"]').getAttribute('aria-expanded'), 'false');
  // Self-description is always editable with an identity, even for guests.
  await page.evaluate(() => {
    const f = (window as any).fixture;
    document.querySelector('#overview')!.replaceChildren(f.renderClientDescriptionEditor(f.members[0]));
  });
  const description = page.getByRole('textbox', { name: 'Minha descrição' });
  assert.equal(await description.inputValue(), 'Main: Pedro Knight');
  assert.equal(await description.getAttribute('maxlength'), '200');
  await description.fill('  Main: New Knight  ');
  await page.getByRole('button', { name: 'salvar descrição' }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).savedDescription), { fingerprint: '1', description: 'Main: New Knight' });
  await description.fill('');
  await description.press('Enter');
  assert.deepEqual(await page.evaluate(() => (window as any).savedDescription), { fingerprint: '1', description: '' });
  assert.deepEqual(await page.evaluate(() => {
    const f = (window as any).fixture;
    const guestBlocked = f.renderClientDescriptionEditor(f.members[1]) === null;
    const noIdentityBlocked = f.renderClientDescriptionEditor({ ...f.members[0], fingerprint: '' }) === null;
    f.client.myGroup = 5; // Moderator, default permission.
    const moderatorAllowed = f.renderClientDescriptionEditor(f.members[1]) !== null;
    f.client.descriptionMinGroup = 6; // Server requires Admin for other members.
    const customPermissionRespected = f.renderClientDescriptionEditor(f.members[1]) === null;
    const selfStillAllowed = f.renderClientDescriptionEditor(f.members[0]) !== null;
    return { guestBlocked, noIdentityBlocked, moderatorAllowed, customPermissionRespected, selfStillAllowed };
  }), { guestBlocked: true, noIdentityBlocked: true, moderatorAllowed: true, customPermissionRespected: true, selfStillAllowed: true });
  // Exercise the selected-profile panel in the same flex stack as the chat.
  await page.evaluate(() => {
    const f = (window as any).fixture;
    const host = document.querySelector('#overview') as HTMLElement;
    host.replaceChildren();
    const talk = document.createElement('section');
    talk.className = 'talk';
    talk.style.height = '580px';
    talk.innerHTML = '<header><span class="name">polakux</span></header>';
    talk.append(f.renderClientInfoPanel(f.members[2]));
    const tabs = document.createElement('div');
    tabs.className = 'chat-tabs';
    tabs.innerHTML = '<button class="chat-tab active"># Lobby</button>';
    const log = document.createElement('div');
    log.className = 'log';
    log.innerHTML = '<div class="line"><time>03:42</time><span class="body"><span class="who">psikin</span> Bora fechar a party?</span></div>';
    const composer = document.createElement('div');
    composer.className = 'composer';
    composer.innerHTML = '<input placeholder="mensagem…" aria-label="mensagem" />';
    talk.append(tabs, log, composer);
    host.append(talk);
    document.querySelectorAll('.tree .peer').forEach((el, index) => el.classList.toggle('selected', index === 2));
  });
  for (const width of [1280, 900, 390]) {
    await page.setViewportSize({ width, height: 820 });
    const geometry = await page.evaluate(() => {
      const [panel, name, group, game, log, composer] = [
        '.talk > .profile-panel', '.profile-compact .user-profile-name',
        '.profile-compact .profile-badge.group', '.profile-compact .profile-badge.game',
        '.talk .log', '.talk .composer',
      ].map(selector => document.querySelector(selector)!.getBoundingClientRect());
      return {
        visibleIdentity: [name, group, game].every(rect => rect.top >= panel.top && rect.bottom <= panel.bottom),
        chatSpace: log.height >= 180,
        noOverlap: log.top >= panel.bottom && composer.top >= log.bottom - 1,
        noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    assert.deepEqual(geometry, { visibleIdentity: true, chatSpace: true, noOverlap: true, noHorizontalOverflow: true }, `Selected profile layout at ${width}`);
  }
  assert.match(await page.locator('.profile-compact .profile-badge.game').innerText(), /Master Sorcerer · Lv\. 1032/);
  assert.equal(await page.locator('.profile-compact .profile-badge.group').innerText(), 'Visitante');
  assert.equal(await page.locator('.profile-session-details').getAttribute('open'), null);
  await page.locator('.talk').evaluate((el: HTMLElement) => { el.style.height = '420px'; });
  assert.ok(await page.evaluate(() => {
    const panel = document.querySelector('.talk > .profile-panel')!.getBoundingClientRect();
    const group = document.querySelector('.profile-compact .profile-badge.group')!.getBoundingClientRect();
    return group.bottom <= panel.bottom && document.querySelector('.talk .log')!.getBoundingClientRect().height >= 100;
  }), 'Small window must retain group and chat');
  await page.locator('.talk').evaluate((el: HTMLElement) => { el.style.height = '580px'; });
  await page.locator('.profile-session-details summary').click();
  assert.equal(await page.locator('.profile-session-about').innerText(), 'Main: Ancient Sorcerer With A Long Name');
  assert.ok((await page.locator('.talk .log').boundingBox())!.height >= 180);
  await page.locator('.profile-session-details summary').click();
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.screenshot({ path: join(out, 'selected-profile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`PASS: channel interactions; self-description and permissions; compact profile metadata and visible chat at 3 widths.\nPreview: ${out}`);
} finally { await browser.close(); }
