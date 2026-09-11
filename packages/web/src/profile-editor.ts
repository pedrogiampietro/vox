import type { ClientInfo, UserProfile } from '@vox/protocol';
import { $, text } from './ui/dom.js';
import { t } from './i18n.js';
import { DEFAULT_PROFILE_ACCENT, PROFILE_FRAMES, encodeProfileAvatar, encodeProfileBanner, normalizeProfile } from './profile.js';

export const PROFILE_COVERS = [
  { id: 'signature', label: 'Assinatura' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'sunset', label: 'Horizonte' },
  { id: 'orbit', label: 'Órbita' },
  { id: 'grid', label: 'Radar' },
  { id: 'solid', label: 'Minimal' },
] as const;

const ACCENTS = [
  ['#e8a33d', 'Âmbar'], ['#ef806c', 'Coral'], ['#e787b4', 'Rosa'],
  ['#a58bfa', 'Lavanda'], ['#7fc8ed', 'Gelo'], ['#69cfab', 'Menta'],
] as const;

interface ProfileEditorOptions {
  me: ClientInfo;
  profile: UserProfile;
  renderCard: (person: ClientInfo, profile: UserProfile) => HTMLElement;
  renderAvatar: (person: ClientInfo, profile: UserProfile, className: string) => HTMLElement;
  publish: (profile: UserProfile, nickname: string, description: string) => Promise<void>;
}

/** Usado na capa real e nas amostras: o editor mostra exatamente o que será salvo. */
export function renderProfileCover(profile: UserProfile): HTMLElement {
  const cover = $('div', `user-profile-cover profile-cover-${profile.bannerStyle ?? 'signature'}`);
  cover.style.setProperty('--profile-accent', profile.accent || DEFAULT_PROFILE_ACCENT);
  cover.setAttribute('aria-hidden', 'true');
  if (profile.banner) {
    const image = $('img') as HTMLImageElement;
    image.src = profile.banner;
    image.alt = '';
    image.draggable = false;
    cover.classList.add('has-image');
    image.addEventListener('error', () => { image.remove(); cover.classList.remove('has-image'); }, { once: true });
    cover.append(image);
  }
  cover.append(text('span', 'user-profile-monogram', 'v0x'));
  return cover;
}

export function buildProfileEditor(body: HTMLElement, options: ProfileEditorOptions): void {
  const { me, renderAvatar, renderCard } = options;
  let draft = normalizeProfile(options.profile);
  let saved = { profile: { ...draft }, nickname: me.nickname, description: me.description ?? '' };
  let saving = false;
  const heading = $('header', 'profile-studio-heading');
  heading.append(text('span', 'user-profile-kicker', t('MEU PERFIL')), text('h2', '', t('Um perfil com a sua cara.')),
    text('p', '', t('Escolha sua capa, encontre seu estilo e faça parte da conversa.')));

  const layout = $('div', 'profile-settings-layout');
  const editor = $('div', 'profile-editor');
  const preview = $('aside', 'profile-preview-column');
  const previewLabel = $('div', 'profile-preview-label');
  previewLabel.append(text('span', 'user-profile-kicker', t('PRÉVIA AO VIVO')), text('span', 'profile-preview-live', t('só você vê')));
  const previewHost = $('div', 'profile-preview-host');
  const channelPreview = $('div', 'profile-channel-preview');
  preview.append(previewLabel, previewHost, text('span', 'user-profile-kicker profile-channel-label', t('NA LISTA DE CANAIS')), channelPreview,
    text('p', 'settings-note profile-preview-note', t('Sua identidade, do cartão à conversa. As mudanças aparecem para todos ao salvar.')));

  const name = input('text', me.nickname, 32);
  name.setAttribute('autocomplete', 'nickname');
  const status = input('text', draft.statusText, 64);
  status.placeholder = t('ex: organizando a próxima hunt');
  const about = $('textarea') as HTMLTextAreaElement;
  about.value = me.description ?? '';
  about.maxLength = 200;
  about.rows = 5;
  about.placeholder = t('Conte sobre você. Para integrar o personagem, use Main: Nome do Char.');
  const accent = input('color', draft.accent);
  accent.setAttribute('aria-label', t('Cor de destaque do perfil'));

  const saveState = text('span', 'profile-save-state', t('Tudo salvo. Do seu jeito.'));
  saveState.setAttribute('role', 'status');
  saveState.setAttribute('aria-live', 'polite');
  const save = button('salvar perfil', 'primary profile-save');
  const reset = button('descartar alterações', 'ghost profile-discard');
  const actions = $('div', 'profile-save-actions');
  actions.append(reset, save);
  const saveRow = $('div', 'profile-save-row');
  saveRow.append(saveState, actions);

  const appearance = $('div', 'profile-editor-pane');
  const introduction = $('div', 'profile-editor-pane');
  const panes = [appearance, introduction];
  const tabs = $('div', 'profile-editor-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', t('Personalizar perfil'));
  const tabButtons = ['Aparência', 'Sobre mim'].map((label, index) => {
    const tab = button(label);
    tab.id = `profile-tab-${index}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `profile-pane-${index}`);
    panes[index]!.id = `profile-pane-${index}`;
    panes[index]!.setAttribute('role', 'tabpanel');
    panes[index]!.setAttribute('aria-labelledby', tab.id);
    tab.addEventListener('click', () => selectTab(index));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      selectTab(next);
      tabButtons[next]!.focus();
    });
    return tab;
  });
  function selectTab(index: number): void {
    tabButtons.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panes[i]!.hidden = i !== index;
    });
  }
  tabs.append(...tabButtons);
  selectTab(0);

  const bannerSection = section('CAPA DO PERFIL', 'O cenário da sua identidade.');
  const bannerUpload = imagePicker('banner');
  const coverGrid = $('div', 'profile-cover-options');
  coverGrid.setAttribute('role', 'radiogroup');
  coverGrid.setAttribute('aria-label', t('Capas prontas'));
  const coverRadios = PROFILE_COVERS.map((cover) => {
    const option = $('label', 'profile-cover-option');
    const radio = input('radio', cover.id);
    radio.name = 'profile-cover';
    radio.setAttribute('aria-label', t(cover.label));
    const sample = renderProfileCover({ ...draft, banner: '', bannerStyle: cover.id });
    option.append(radio, sample, text('span', 'profile-cover-name', t(cover.label)), text('span', 'profile-option-check', '✓'));
    radio.addEventListener('change', () => {
      draft.bannerStyle = cover.id;
      draft.banner = '';
      bannerUpload.clear();
      refresh();
    });
    coverGrid.append(option);
    return radio;
  });
  bannerSection.append(bannerUpload.element, text('span', 'profile-choice-label', t('OU ESCOLHA UMA CAPA')), coverGrid);

  const avatarSection = section('AVATAR', 'Uma foto, um personagem, você.');
  const avatarUpload = imagePicker('avatar');
  avatarSection.append(avatarUpload.element);

  const styleSection = section('SEU ESTILO', 'Os detalhes fazem a diferença.');
  const accentRow = $('div', 'profile-accent-row');
  const accentCopy = $('div');
  accentCopy.append(text('strong', '', t('Cor de destaque')), text('span', 'settings-note', t('Combine a capa e a moldura.')));
  const resetAccent = button('restaurar', 'ghost profile-accent-reset');
  resetAccent.addEventListener('click', () => { accent.value = DEFAULT_PROFILE_ACCENT; refresh(); });
  accentRow.append(accentCopy, accent, resetAccent);
  const palette = $('div', 'profile-palette');
  const swatches = ACCENTS.map(([color, label]) => {
    const swatch = button(label, 'profile-swatch');
    swatch.textContent = '';
    swatch.style.setProperty('--swatch', color);
    swatch.setAttribute('aria-label', t(label));
    swatch.title = t(label);
    swatch.addEventListener('click', () => { accent.value = color; refresh(); });
    palette.append(swatch);
    return swatch;
  });
  const frameGrid = $('div', 'profile-frame-grid');
  frameGrid.setAttribute('role', 'radiogroup');
  frameGrid.setAttribute('aria-label', t('Moldura do avatar'));
  const frameRadios = PROFILE_FRAMES.map((frame) => {
    const option = $('label', 'profile-frame-option');
    option.title = t(frame.hint);
    const radio = input('radio', frame.id);
    radio.name = 'profile-border';
    radio.setAttribute('aria-label', t(frame.label));
    const sample = $('span', 'profile-frame-preview');
    option.append(radio, sample, text('span', 'profile-frame-name', t(frame.label)));
    radio.addEventListener('change', () => { draft.border = frame.id; refresh(); });
    frameGrid.append(option);
    return { radio, sample, frame };
  });
  styleSection.append(accentRow, palette, text('span', 'profile-choice-label', t('MOLDURA DO AVATAR')), frameGrid);
  appearance.append(bannerSection, avatarSection, styleSection);
  const info = section('APRESENTAÇÃO', 'O que a galera precisa saber sobre você.');
  info.append(field('Nome exibido', name, 'O mesmo nome usado na lista de canais.'),
    field('Recado de status', status, 'Uma frase curta visível abaixo do seu nome.'),
    field('Sobre você', about, 'Para vincular seu personagem, use Main: Nome do Char.'));
  introduction.append(info);

  function snapshot(): string {
    return JSON.stringify([name.value.trim(), about.value.trim(), draft.avatar, draft.banner, draft.bannerStyle, draft.border, draft.accent, draft.statusText]);
  }
  let baseline = snapshot();
  function refresh(): void {
    draft.accent = accent.value;
    draft.statusText = status.value.trim();
    editor.style.setProperty('--profile-accent', draft.accent);
    const person = { ...me, nickname: name.value.trim() || me.nickname, description: about.value.trim() };
    previewHost.replaceChildren(renderCard(person, draft));
    const channelCopy = $('div');
    const channelName = text('strong', '', person.nickname);
    channelName.dataset.i18nSkip = '';
    const channelStatus = text('span', '', draft.statusText || t('Online agora'));
    channelStatus.dataset.i18nSkip = '';
    channelCopy.append(channelName, channelStatus);
    channelPreview.replaceChildren(renderAvatar(person, draft, 'profile-avatar-channel-preview'), channelCopy);
    bannerUpload.refresh();
    avatarUpload.refresh();
    coverRadios.forEach((radio, i) => {
      radio.checked = !draft.banner && draft.bannerStyle === PROFILE_COVERS[i]!.id;
      radio.closest('label')!.classList.toggle('selected', radio.checked);
      (radio.nextElementSibling as HTMLElement).style.setProperty('--profile-accent', draft.accent);
    });
    frameRadios.forEach(({ radio, sample, frame }) => {
      radio.checked = draft.border === frame.id;
      radio.closest('label')!.classList.toggle('selected', radio.checked);
      sample.replaceChildren(renderAvatar(person, { ...draft, border: frame.id }, 'profile-avatar-frame-preview'));
    });
    swatches.forEach((swatch, i) => swatch.setAttribute('aria-pressed', String(ACCENTS[i]![0] === draft.accent)));
    const dirty = snapshot() !== baseline;
    save.disabled = saving || !dirty;
    reset.disabled = saving || !dirty;
    if (!saving) {
      saveState.className = 'profile-save-state';
      saveState.textContent = t(dirty ? 'Você tem alterações não salvas.' : 'Tudo salvo. Do seu jeito.');
    }
  }

  reset.addEventListener('click', () => {
    draft = { ...saved.profile };
    name.value = saved.nickname;
    about.value = saved.description;
    status.value = draft.statusText;
    accent.value = draft.accent;
    [name, status, about].forEach((control) => control.dispatchEvent(new Event('input')));
    bannerUpload.clear();
    avatarUpload.clear();
    refresh();
  });
  save.addEventListener('click', async () => {
    if (saving) return;
    if (!name.value.trim()) {
      selectTab(1);
      name.focus();
      saveState.className = 'profile-save-state error';
      saveState.textContent = t('Informe um nome para salvar.');
      return;
    }
    saving = true;
    refresh();
    const controls = [...editor.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button')];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    save.textContent = t('salvando…');
    saveState.className = 'profile-save-state loading';
    saveState.textContent = t('Sincronizando com o servidor…');
    try {
      await options.publish({ ...draft }, name.value.trim(), about.value.trim());
      saved = { profile: { ...draft }, nickname: name.value.trim(), description: about.value.trim() };
      baseline = snapshot();
      saveState.className = 'profile-save-state success';
      saveState.textContent = t('Perfil salvo e publicado.');
    } catch (error) {
      saveState.className = 'profile-save-state error';
      saveState.textContent = error instanceof Error ? t(error.message) : t('Não foi possível salvar o perfil. Tente novamente.');
    } finally {
      saving = false;
      controls.forEach((control, i) => { control.disabled = disabled[i]!; });
      save.textContent = t('salvar perfil');
      save.disabled = reset.disabled = snapshot() === baseline;
    }
  });
  [name, status, about, accent].forEach((control) => control.addEventListener('input', refresh));
  editor.append(tabs, appearance, introduction);
  layout.append(editor, preview);
  body.append(heading, layout, saveRow);
  refresh();

  function imagePicker(kind: 'avatar' | 'banner') {
    let generation = 0;
    const isBanner = kind === 'banner';
    const element = $('div', `profile-image-picker profile-image-picker-${kind}`);
    const row = $('div', 'profile-image-picker-row');
    const visual = $('div', 'profile-upload-visual');
    const choose = button(isBanner ? 'enviar banner' : 'trocar avatar', 'ghost profile-upload-button');
    const remove = button('remover', 'ghost profile-image-remove');
    const file = input('file', '');
    file.accept = 'image/png,image/jpeg,image/webp';
    file.hidden = true;
    file.setAttribute('aria-label', t(isBanner ? 'Escolher uma imagem para o banner' : 'Escolher uma imagem para o avatar'));
    const copy = $('div', 'profile-upload-copy');
    const buttons = $('div', 'profile-avatar-buttons');
    buttons.append(choose, remove, file);
    copy.append(buttons, text('span', 'settings-note', t(isBanner ? 'Arraste uma imagem aqui · proporção 3:1' : 'Arraste sua foto aqui. Ajuste o recorte do seu jeito.')),
      text('span', 'settings-note', t('JPG, PNG ou WebP · até 10 MB')));
    row.append(visual, copy);
    const state = $('div', 'profile-image-state');
    state.setAttribute('role', 'status');
    state.setAttribute('aria-live', 'polite');
    const crop = $('div', 'profile-crop-host');
    element.append(row, state, crop);
    const clear = () => { generation++; crop.replaceChildren(); state.textContent = ''; };
    choose.addEventListener('click', () => file.click());
    remove.addEventListener('click', () => { draft[kind] = ''; clear(); refresh(); });
    const showError = (message: string) => { state.className = 'profile-image-state error'; state.textContent = t(message); };
    const select = async (selected?: File) => {
      if (!selected || saving) return;
      const run = ++generation;
      crop.replaceChildren();
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(selected.type)) return showError('Escolha JPG, PNG ou WebP.');
      if (selected.size > 10 * 1024 * 1024) return showError('A imagem ultrapassa o limite de 10 MB.');
      state.className = 'profile-image-state loading';
      state.textContent = t('Preparando recorte…');
      const url = URL.createObjectURL(selected);
      const image = new Image();
      image.src = url;
      try {
        await image.decode();
        if (run !== generation || !element.isConnected) return;
        state.textContent = '';
        buildProfileCropper(crop, image, kind, (value) => {
          if (saving || run !== generation) return;
          draft[kind] = value;
          clear();
          refresh();
          state.className = 'profile-image-state success';
          state.textContent = t('Recorte aplicado. Salve o perfil para publicar.');
          choose.focus();
        }, showError, () => { clear(); choose.focus(); });
      } catch { if (run === generation) showError('Não foi possível abrir essa imagem.'); }
      finally { URL.revokeObjectURL(url); }
    };
    file.addEventListener('change', () => { const selected = file.files?.[0]; file.value = ''; void select(selected); });
    row.addEventListener('dragover', (event) => { event.preventDefault(); if (!saving) row.classList.add('drag-over'); });
    row.addEventListener('dragleave', (event) => { if (!row.contains(event.relatedTarget as Node | null)) row.classList.remove('drag-over'); });
    row.addEventListener('drop', (event) => { event.preventDefault(); row.classList.remove('drag-over'); void select(event.dataTransfer?.files[0]); });
    return { element, clear, refresh: () => {
      visual.replaceChildren(isBanner ? renderProfileCover(draft) : renderAvatar({ ...me, nickname: name.value.trim() || me.nickname }, draft, 'profile-avatar-editor'));
      remove.hidden = !draft[kind];
      choose.textContent = t(isBanner ? (draft.banner ? 'trocar banner' : 'enviar banner') : (draft.avatar ? 'trocar avatar' : 'enviar avatar'));
    } };
  }
}

function input(type: string, value: string, maxLength?: number): HTMLInputElement {
  const control = $('input') as HTMLInputElement;
  control.type = type;
  control.value = value;
  if (maxLength) control.maxLength = maxLength;
  return control;
}

function button(label: string, className = ''): HTMLButtonElement {
  const control = $('button', className) as HTMLButtonElement;
  control.type = 'button';
  control.textContent = t(label);
  return control;
}

function section(label: string, hint: string): HTMLElement {
  const node = $('section', 'profile-editor-section');
  const heading = $('div', 'profile-section-title');
  heading.append(text('span', 'user-profile-kicker', t(label)), text('span', 'settings-note', t(hint)));
  node.append(heading);
  return node;
}

function field(label: string, control: HTMLInputElement | HTMLTextAreaElement, hint: string): HTMLElement {
  const node = $('label', 'profile-field');
  const top = $('span', 'profile-field-top');
  const count = text('small', 'profile-field-count', `${control.value.length}/${control.maxLength}`);
  count.setAttribute('aria-hidden', 'true');
  control.addEventListener('input', () => { count.textContent = `${control.value.length}/${control.maxLength}`; });
  top.append(text('span', 'profile-field-label', t(label)), count);
  node.append(top, control, text('small', '', t(hint)));
  return node;
}
function buildProfileCropper(
  host: HTMLElement,
  image: HTMLImageElement,
  kind: 'avatar' | 'banner',
  onApply: (value: string) => void,
  onError: (message: string) => void,
  onCancel: () => void,
): void {
  const isBanner = kind === 'banner';
  const panel = $('div', 'profile-cropper');
  const heading = $('div', 'profile-cropper-heading');
  heading.append(text('strong', '', t(isBanner ? 'Ajustar banner' : 'Ajustar avatar')), text('span', 'settings-note', t('Arraste para reposicionar e use o zoom.')));
  const canvas = $('canvas', `profile-crop-canvas${isBanner ? ' profile-crop-banner' : ''}`) as HTMLCanvasElement;
  canvas.width = isBanner ? 960 : 320;
  canvas.height = 320;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', t(isBanner ? 'Área de recorte do banner. Use as setas para reposicionar.' : 'Área de recorte do avatar. Use as setas para reposicionar.'));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    onError(t('Seu navegador não conseguiu processar a imagem.'));
    return;
  }

  let zoom = 1;
  let offsetX = 0;
  let offsetY = 0;
  let pointer = 0;
  let startX = 0;
  let startY = 0;
  let startOffsetX = 0;
  let startOffsetY = 0;

  const draw = (): void => {
    const base = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const scale = base * zoom;
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    const limitX = Math.max(0, (width - canvas.width) / 2);
    const limitY = Math.max(0, (height - canvas.height) / 2);
    offsetX = Math.max(-limitX, Math.min(limitX, offsetX));
    offsetY = Math.max(-limitY, Math.min(limitY, offsetY));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, (canvas.width - width) / 2 + offsetX, (canvas.height - height) / 2 + offsetY, width, height);
  };

  canvas.addEventListener('pointerdown', (event) => {
    pointer = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startOffsetX = offsetX;
    startOffsetY = offsetY;
    canvas.setPointerCapture(pointer);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (event) => {
    if (pointer !== event.pointerId) return;
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    offsetX = startOffsetX + (event.clientX - startX) * ratio;
    offsetY = startOffsetY + (event.clientY - startY) * ratio;
    draw();
  });
  const release = (event: PointerEvent): void => {
    if (pointer !== event.pointerId) return;
    pointer = 0;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 12 : 4;
    if (event.key === 'ArrowLeft') offsetX -= step;
    else if (event.key === 'ArrowRight') offsetX += step;
    else if (event.key === 'ArrowUp') offsetY -= step;
    else if (event.key === 'ArrowDown') offsetY += step;
    else return;
    event.preventDefault();
    draw();
  });

  const zoomRow = $('label', 'profile-zoom-row');
  zoomRow.append(text('span', '', t('Zoom')));
  const zoomInput = $('input') as HTMLInputElement;
  zoomInput.type = 'range';
  zoomInput.min = '100';
  zoomInput.max = '300';
  zoomInput.value = '100';
  zoomInput.setAttribute('aria-label', t(isBanner ? 'Zoom do banner' : 'Zoom do avatar'));
  const zoomValue = text('span', '', '100%');
  zoomInput.addEventListener('input', () => {
    zoom = Number(zoomInput.value) / 100;
    zoomValue.textContent = `${zoomInput.value}%`;
    draw();
  });
  zoomRow.append(zoomInput, zoomValue);

  const actions = $('div', 'profile-crop-actions');
  const cancel = $('button', 'ghost');
  cancel.textContent = t('cancelar');
  cancel.addEventListener('click', onCancel);
  const apply = $('button', 'primary');
  apply.textContent = t('usar este recorte');
  apply.addEventListener('click', () => {
    apply.disabled = true;
    apply.textContent = t('processando…');
    try {
      onApply(isBanner ? encodeProfileBanner(canvas) : encodeProfileAvatar(canvas));
    } catch (error) {
      apply.disabled = false;
      apply.textContent = t('usar este recorte');
      onError(error instanceof Error ? t(error.message) : t('Não foi possível processar a imagem.'));
    }
  });
  actions.append(cancel, apply);
  panel.append(heading, canvas, zoomRow, actions);
  host.append(panel);
  draw();
  canvas.focus({ preventScroll: true });
}
