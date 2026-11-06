(() => {
  'use strict';

  const ICO_SIZE_OPTIONS = [16, 32, 48, 64, 96, 128, 256];
  const DEFAULT_ICO_SIZES = [16, 32, 48];
  const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  const ACCEPTED_EXT = /\.(png|jpe?g|webp)$/i;
  const MAX_BYTES = 10 * 1024 * 1024;
  const MAX_PIXELS = 40_000_000;
  const MASTER_MAX = 1024;
  const BMP_MAX = 48;
  const LOW_RES_WARNING = 256;

  const $ = (id) => document.getElementById(id);
  const fileInput = $('file-input');
  const dropzone = $('dropzone');
  const convertButton = $('convert-button');
  const convertLabel = convertButton.querySelector('.convert-label');
  const downloadIcoButton = $('download-ico');
  const downloadPackButton = $('download-pack');
  const toggle = $('transparency-toggle');
  const sizeTags = $('size-tags');
  const settingsBadge = $('settings-badge');
  const previewStage = $('preview-stage');
  const previewMain = $('preview-main');
  const tabIcon = $('tab-icon');
  const tabTitle = $('tab-title');
  const previewState = $('preview-state');
  const previewCaption = $('preview-caption');
  const captionCheck = $('caption-check');
  const statusMessage = $('status-message');
  const snippet = $('snippet');
  const snippetCode = $('snippet-code');
  const copyButton = $('copy-snippet');

  const state = {
    master: null,
    objectUrl: null,
    baseName: 'favicon',
    keepTransparency: true,
    icoSizes: new Set(DEFAULT_ICO_SIZES),
    ico: null,
    pack: null,
    loadToken: 0,
  };

  const HEAD_SNIPPET = [
    '<link rel="icon" href="/favicon.ico" sizes="any">',
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
    '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
  ].join('\n');

  function setMessage(message, kind = 'success') {
    statusMessage.textContent = message;
    statusMessage.classList.toggle('is-error', kind === 'error');
    statusMessage.classList.toggle('is-info', kind === 'info');
  }

  function formatSizes(sizes) {
    const list = [...sizes].sort((a, b) => a - b);
    if (list.length === 1) return `${list[0]}`;
    return `${list.slice(0, -1).join(', ')} & ${list[list.length - 1]}`;
  }

  function createCanvas(size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return canvas;
  }

  function context2d(canvas) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable in this browser.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    return context;
  }

  function resizeSquare(source, sx, sy, sourceSize, target, background = null) {
    let current = source;
    let x = sx;
    let y = sy;
    let size = sourceSize;
    while (size > target * 2) {
      const next = Math.round(size / 2);
      const step = createCanvas(next);
      context2d(step).drawImage(current, x, y, size, size, 0, 0, next, next);
      current = step;
      x = 0;
      y = 0;
      size = next;
    }
    const output = createCanvas(target);
    const context = context2d(output);
    if (background) {
      context.fillStyle = background;
      context.fillRect(0, 0, target, target);
    }
    context.drawImage(current, x, y, size, size, 0, 0, target, target);
    return output;
  }

  function buildMaster(image) {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const side = Math.min(width, height);
    const sx = (width - side) / 2;
    const sy = (height - side) / 2;
    return resizeSquare(image, sx, sy, side, Math.min(side, MASTER_MAX));
  }

  function renderIcon(size, { forceOpaque = false } = {}) {
    const opaque = forceOpaque || !state.keepTransparency;
    return resizeSquare(state.master, 0, 0, state.master.width, size, opaque ? '#ffffff' : null);
  }

  function canvasToPngBytes(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) return reject(new Error('Could not create an icon image.'));
        resolve(new Uint8Array(await blob.arrayBuffer()));
      }, 'image/png');
    });
  }

  function canvasToIcoBmpBytes(canvas) {
    const size = canvas.width;
    const { data } = context2d(canvas).getImageData(0, 0, size, size);
    const maskRowBytes = Math.ceil(size / 32) * 4;
    const pixelBytes = size * size * 4;
    const maskBytes = maskRowBytes * size;
    const out = new Uint8Array(40 + pixelBytes + maskBytes);
    const view = new DataView(out.buffer);
    view.setUint32(0, 40, true);
    view.setInt32(4, size, true);
    view.setInt32(8, size * 2, true);
    view.setUint16(12, 1, true);
    view.setUint16(14, 32, true);
    view.setUint32(16, 0, true);
    view.setUint32(20, pixelBytes + maskBytes, true);

    let offset = 40;
    for (let row = size - 1; row >= 0; row -= 1) {
      for (let col = 0; col < size; col += 1) {
        const i = (row * size + col) * 4;
        out[offset++] = data[i + 2];
        out[offset++] = data[i + 1];
        out[offset++] = data[i];
        out[offset++] = data[i + 3];
      }
    }
    const maskStart = offset;
    for (let row = size - 1; row >= 0; row -= 1) {
      const rowStart = maskStart + (size - 1 - row) * maskRowBytes;
      for (let col = 0; col < size; col += 1) {
        if (data[(row * size + col) * 4 + 3] === 0) out[rowStart + (col >> 3)] |= 0x80 >> (col & 7);
      }
    }
    return out;
  }

  async function makeIco(sizes) {
    const entries = [];
    for (const size of sizes) {
      const canvas = renderIcon(size);
      const bytes = size <= BMP_MAX ? canvasToIcoBmpBytes(canvas) : await canvasToPngBytes(canvas);
      entries.push({ size, bytes });
    }
    const headerLength = 6 + 16 * entries.length;
    const total = headerLength + entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
    const output = new Uint8Array(total);
    const view = new DataView(output.buffer);
    view.setUint16(0, 0, true);
    view.setUint16(2, 1, true);
    view.setUint16(4, entries.length, true);
    let offset = headerLength;
    entries.forEach(({ size, bytes }, index) => {
      const entry = 6 + index * 16;
      output[entry] = size >= 256 ? 0 : size;
      output[entry + 1] = size >= 256 ? 0 : size;
      output[entry + 2] = 0;
      output[entry + 3] = 0;
      view.setUint16(entry + 4, 1, true);
      view.setUint16(entry + 6, 32, true);
      view.setUint32(entry + 8, bytes.length, true);
      view.setUint32(entry + 12, offset, true);
      output.set(bytes, offset);
      offset += bytes.length;
    });
    return { blob: new Blob([output], { type: 'image/x-icon' }), bytes: output };
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeZip(files) {
    const encoder = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
      const crc = crc32(data);

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);
      centralParts.push(central);

      offset += local.length + data.length;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
  }

  async function makePack(icoBytes) {
    const png = (size, options) => canvasToPngBytes(renderIcon(size, options));
    const manifest = {
      name: 'My website',
      short_name: 'Website',
      icons: [
        { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
      ],
      theme_color: '#ffffff',
      background_color: '#ffffff',
      display: 'standalone',
    };
    const files = [
      { name: 'favicon.ico', data: icoBytes },
      { name: 'favicon-16x16.png', data: await png(16) },
      { name: 'favicon-32x32.png', data: await png(32) },
      { name: 'apple-touch-icon.png', data: await png(180, { forceOpaque: true }) },
      { name: 'android-chrome-192x192.png', data: await png(192) },
      { name: 'android-chrome-512x512.png', data: await png(512) },
      { name: 'site.webmanifest', data: JSON.stringify(manifest, null, 2) + '\n' },
      { name: 'head-snippet.html', data: `<!-- Paste inside <head> -->\n${HEAD_SNIPPET}\n` },
    ];
    return makeZip(files);
  }

  function setDownloadsEnabled(enabled) {
    downloadIcoButton.disabled = !enabled;
    downloadPackButton.disabled = !enabled;
    captionCheck.classList.toggle('is-visible', enabled);
    snippet.hidden = !enabled;
  }

  function invalidateOutput({ announce = true } = {}) {
    const hadOutput = Boolean(state.ico);
    state.ico = null;
    state.pack = null;
    setDownloadsEnabled(false);
    if (state.master) {
      previewCaption.textContent = 'This is exactly how your icon will look';
      if (hadOutput && announce) setMessage('Settings changed — make your favicon again to update the download.', 'info');
    }
  }

  function renderPreview() {
    if (!state.master) return;
    const small = renderIcon(16);
    const large = renderIcon(48);
    for (const canvas of [small, large]) {
      canvas.className = 'icon-canvas';
      canvas.style.width = `${canvas.width}px`;
      canvas.style.height = `${canvas.height}px`;
    }
    tabIcon.replaceChildren(small);
    previewMain.replaceChildren(large);
    tabIcon.style.background = 'transparent';
    previewStage.classList.add('has-image');
  }

  function renderSizeTags() {
    sizeTags.replaceChildren(
      ...ICO_SIZE_OPTIONS.map((size) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'size-tag';
        button.textContent = size;
        button.dataset.size = String(size);
        button.setAttribute('aria-pressed', String(state.icoSizes.has(size)));
        button.setAttribute('aria-label', `${size} pixels`);
        return button;
      }),
    );
  }

  function loadFile(file) {
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type) && !ACCEPTED_EXT.test(file.name)) {
      setMessage('Please choose a PNG, JPEG, or WebP image.', 'error');
      return;
    }
    if (file.size > MAX_BYTES) {
      setMessage('That image is over 10 MB. Choose a smaller file.', 'error');
      return;
    }

    const token = ++state.loadToken;
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      if (token !== state.loadToken) return URL.revokeObjectURL(url);
      const { naturalWidth: width, naturalHeight: height } = image;
      if (width * height > MAX_PIXELS) {
        URL.revokeObjectURL(url);
        setMessage(`That image is ${width} × ${height} px — too large to process safely. Try one under 40 megapixels.`, 'error');
        return;
      }
      let master;
      try {
        master = buildMaster(image);
      } catch (error) {
        URL.revokeObjectURL(url);
        setMessage(error.message || 'We couldn’t process that image.', 'error');
        return;
      }

      if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = url;
      state.master = master;
      state.baseName = file.name.replace(/\.[^.]+$/, '') || 'favicon';

      invalidateOutput({ announce: false });
      renderPreview();
      tabTitle.textContent = state.baseName.slice(0, 28);
      const cropped = width !== height;
      previewState.textContent = `${width} × ${height}${cropped ? ' · CROPPED TO SQUARE' : ''}`;
      settingsBadge.innerHTML = '<span aria-hidden="true"></span> READY TO GO';
      settingsBadge.classList.add('is-ready');
      convertButton.disabled = false;

      const notes = [];
      if (cropped) notes.push('We cropped the centre square of your image.');
      if (Math.min(width, height) < LOW_RES_WARNING) notes.push(`It’s under ${LOW_RES_WARNING} px, so the larger sizes may look soft.`);
      setMessage(notes.join(' '), 'info');
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      if (token !== state.loadToken) return;
      setMessage('We couldn’t read that image. Try another PNG, JPEG, or WebP.', 'error');
    };

    image.src = url;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    loadFile(fileInput.files[0]);
    fileInput.value = '';
  });

  let dragDepth = 0;
  dropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    dropzone.classList.add('dragging');
  });
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  dropzone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove('dragging');
  });
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('dragging');
    loadFile(event.dataTransfer && event.dataTransfer.files[0]);
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  toggle.addEventListener('click', () => {
    state.keepTransparency = !state.keepTransparency;
    toggle.classList.toggle('is-on', state.keepTransparency);
    toggle.setAttribute('aria-checked', String(state.keepTransparency));
    invalidateOutput();
    renderPreview();
  });

  sizeTags.addEventListener('click', (event) => {
    const button = event.target.closest('.size-tag');
    if (!button) return;
    const size = Number(button.dataset.size);
    if (state.icoSizes.has(size)) {
      if (state.icoSizes.size === 1) {
        setMessage('Keep at least one size in the .ICO.', 'error');
        return;
      }
      state.icoSizes.delete(size);
    } else {
      state.icoSizes.add(size);
    }
    button.setAttribute('aria-pressed', String(state.icoSizes.has(size)));
    invalidateOutput();
  });

  convertButton.addEventListener('click', async () => {
    if (!state.master) return;
    convertButton.disabled = true;
    convertButton.setAttribute('aria-busy', 'true');
    convertLabel.textContent = 'Making your favicon…';
    setMessage('');
    const sizes = [...state.icoSizes].sort((a, b) => a - b);
    try {
      const ico = await makeIco(sizes);
      const pack = await makePack(ico.bytes);
      state.ico = ico.blob;
      state.pack = pack;
      setDownloadsEnabled(true);
      previewCaption.textContent = 'Your favicon is ready to download';
      previewState.textContent = 'ALL SIZES READY';
      setMessage(`Made with ${formatSizes(sizes)} px icons, plus a PNG pack for phones and apps.`);
    } catch (error) {
      setMessage(error.message || 'Something went wrong. Please try again.', 'error');
    } finally {
      convertButton.disabled = false;
      convertButton.removeAttribute('aria-busy');
      convertLabel.textContent = 'Make my favicon';
    }
  });

  downloadIcoButton.addEventListener('click', () => {
    if (state.ico) saveBlob(state.ico, 'favicon.ico');
  });
  downloadPackButton.addEventListener('click', () => {
    if (state.pack) saveBlob(state.pack, `${state.baseName}-favicon-pack.zip`);
  });

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(HEAD_SNIPPET);
      copyButton.textContent = 'Copied ✓';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(snippetCode);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      copyButton.textContent = 'Press ⌘/Ctrl + C';
    }
    setTimeout(() => (copyButton.textContent = 'Copy code'), 2000);
  });

  snippetCode.textContent = HEAD_SNIPPET;
  renderSizeTags();
})();
