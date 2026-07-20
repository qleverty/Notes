// =============================================
// CANVAS / PAN / ZOOM
// =============================================

const invoke = window.__TAURI__?.core?.invoke ?? (() => Promise.resolve());

const addBtn      = document.getElementById('add-btn');
const addImageBtn = document.getElementById('add-image-btn');
const imageInput  = document.getElementById('image-file-input');
const canvas      = document.getElementById('canvas');
let zIndexCounter = 10;
let zoom = 1, panX = 0, panY = 0;

marked.setOptions({ breaks: true, gfm: true });

function applyTransform() {
    canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    updateVisibleNotes();
}

function screenToCanvas(sx, sy) {
    return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
}

// Zoom with wheel (but scroll dropdown list if cursor is inside it)
document.addEventListener('wheel', (e) => {
    e.preventDefault(); // always prevent browser scroll/zoom

    const pr = document.getElementById('proj-root');
    if (pr && pr.contains(e.target)) {
        // Cursor is in dropdown zone — scroll the list, never zoom
        const list = document.getElementById('proj-list');
        if (list) {
            const maxScroll = list.scrollHeight - list.clientHeight;
            if (maxScroll > 0) {
                const goingUp   = e.deltaY < 0;
                const atTop     = list.scrollTop <= 0;
                const atBottom  = list.scrollTop >= maxScroll - 1;
                if (!(goingUp && atTop) && !(!goingUp && atBottom)) {
                    list.scrollTop += e.deltaY > 0 ? 40 : -40;
                }
            }
        }
        return; // do NOT zoom canvas
    }

    // Canvas zoom
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.min(Math.max(zoom * factor, ZOOM_MIN), ZOOM_MAX);
    panX = e.clientX - (e.clientX - panX) * (newZoom / zoom);
    panY = e.clientY - (e.clientY - panY) * (newZoom / zoom);
    zoom = newZoom;
    applyTransform();
    updateAnchorPositions();
}, { passive: false });

// Pan with middle mouse
let isPanning = false, panStartX, panStartY, panStartOffX, panStartOffY;
document.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
        e.preventDefault();
        isPanning = true;
        panStartX = e.clientX; panStartY = e.clientY;
        panStartOffX = panX; panStartOffY = panY;
        document.body.style.cursor = 'grabbing';
    }
});
document.addEventListener('mousemove', (e) => {
    if (isPanning) {
        panX = panStartOffX + (e.clientX - panStartX);
        panY = panStartOffY + (e.clientY - panStartY);
        applyTransform(); updateAnchorPositions();
    }
});
document.addEventListener('mouseup', (e) => {
    if (e.button === 1) { isPanning = false; document.body.style.cursor = ''; }
});

// =============================================
// ERROR DISPLAY (stub — полировка в главе 11)
// =============================================

function showError(msg) {
    const el = document.createElement('div');
    el.className = 'error-toast';
    el.textContent = String(msg);
    el.addEventListener('mousedown', () => el.style.background = '#900');
    el.addEventListener('mouseup',   () => el.style.background = '');
    el.addEventListener('click', () => navigator.clipboard.writeText(String(msg)).catch(() => {}));
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

// =============================================
// THREAD SYSTEM
// =============================================

const IMAGE_CACHE_BUDGET = (() => {
    const gb = navigator.deviceMemory ?? 1;
    return Math.min(gb * 1024 * 1024 * 1024 * 0.10, 500 * 1024 * 1024);
})();

class ImageCache {
    constructor(budget) {
        this._budget  = budget;
        this._used    = 0;
        this._entries = new Map();
    }
    get(key) {
        const e = this._entries.get(key);
        if (!e) return null;
        e.lastAccess = Date.now();
        return e.src;
    }
    set(key, src) {
        const size = src.length * 2;
        if (size > this._budget) return false;
        if (this._entries.has(key)) this._used -= this._entries.get(key).size;
        while (this._used + size > this._budget && this._entries.size > 0) this._evict();
        this._entries.set(key, { src, size, lastAccess: Date.now() });
        this._used += size;
        return true;
    }
    invalidate(key) {
        const e = this._entries.get(key);
        if (e) { this._used -= e.size; this._entries.delete(key); }
    }
    invalidateProject(projectName) {
        const prefix = `${projectName}::`;
        for (const key of this._entries.keys())
            if (key.startsWith(prefix)) this.invalidate(key);
    }
    _evict() {
        let oldestKey = null, oldestTime = Infinity;
        for (const [key, e] of this._entries)
            if (e.lastAccess < oldestTime) { oldestTime = e.lastAccess; oldestKey = key; }
        if (!oldestKey) return;
        const [proj, noteId] = oldestKey.split('::');
        if (proj === currentProject) {
            const nd = notesMap.get(noteId);
            if (nd?.kind === 'image') {
                nd.el.querySelector('.note-image').src = '';
                nd.srcLoaded = false;
            }
        }
        this.invalidate(oldestKey);
    }
}

const imageCache = new ImageCache(IMAGE_CACHE_BUDGET);
const cacheKey = (noteId) => `${currentProject}::${noteId}`;

const notesMap = new Map(); // noteId -> { el, anchors, anchorSVG, threadSVG, threadG, previewG }
let dragState = null;

const wiresMap = new Map();

function getAnchorPos(noteId, side) {
    const nd = notesMap.get(noteId);
    if (nd.el.style.display !== 'none') {
        const r = nd.el.getBoundingClientRect();
        switch (side) {
            case 'top':    return { x: r.left + r.width / 2, y: r.top };
            case 'bottom': return { x: r.left + r.width / 2, y: r.bottom };
            case 'left':   return { x: r.left,  y: r.top + r.height / 2 };
            case 'right':  return { x: r.right, y: r.top + r.height / 2 };
        }
    }
    const { x, y, w, h } = nd.slot;
    switch (side) {
        case 'top':    return { x: (x + w / 2) * zoom + panX, y: y * zoom + panY };
        case 'bottom': return { x: (x + w / 2) * zoom + panX, y: (y + h) * zoom + panY };
        case 'left':   return { x: x * zoom + panX,            y: (y + h / 2) * zoom + panY };
        case 'right':  return { x: (x + w) * zoom + panX,      y: (y + h / 2) * zoom + panY };
    }
}

function screenToCanvas2(p1s, p2s) {
    const screenDist = Math.hypot(p2s.x - p1s.x, p2s.y - p1s.y);
    const sagScreen  = Math.min(screenDist * 0.07, 16);
    const p1 = screenToCanvas(p1s.x, p1s.y);
    const p2 = screenToCanvas(p2s.x, p2s.y);
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    return `M ${p1.x} ${p1.y} Q ${mx} ${my + sagScreen / zoom} ${p2.x} ${p2.y}`;
}

function getNearestAnchorSide(noteEl, refPos) {
    let nearest = null, minDist = Infinity;
    ['top','bottom','left','right'].forEach(side => {
        const p = getAnchorPos(noteEl, side);
        const d = Math.hypot(p.x - refPos.x, p.y - refPos.y);
        if (d < minDist) { minDist = d; nearest = side; }
    });
    return nearest;
}

function drawConnections() {
    notesMap.forEach(({ threadG }) => { threadG.innerHTML = ''; });
    const sideNames = ['top', 'right', 'bottom', 'left'];
    wiresMap.forEach(wire => {
        const a = notesMap.get(String(wire.from_id));
        const b = notesMap.get(String(wire.to_id));
        if (!a || !b) return;
        const p1 = getAnchorPos(String(wire.from_id), sideNames[wire.from_side]);
        const p2 = getAnchorPos(String(wire.to_id), sideNames[wire.to_side]);
        _drawWirePath(a.threadG, p1, p2, 'rgba(90,45,12,0.6)', '1.8', 'none');
    });
}

function _drawWirePath(g, p1, p2, stroke, width, dasharray) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', screenToCanvas2(p1, p2));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', width);
    path.setAttribute('stroke-dasharray', dasharray);
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    g.appendChild(path);
}

const SIDE_NUM = { top: 0, right: 1, bottom: 2, left: 3 };

async function onWireCreated(fromId, fromSide, toId, toSide) {
    try {
        const id = await invoke('create_wire', {
            fromId:   toInvokeId(fromId), fromSide: SIDE_NUM[fromSide],
            toId:     toInvokeId(toId),   toSide:   SIDE_NUM[toSide],
            color:    APP_CONSTANTS.DEFAULT_COLOR,
        });
        wiresMap.set(id, {
            id,
            from_id: toInvokeId(fromId), from_side: SIDE_NUM[fromSide],
            to_id:   toInvokeId(toId),   to_side:   SIDE_NUM[toSide],
            color:   APP_CONSTANTS.DEFAULT_COLOR,
        });
        drawConnections();
    } catch (e) { console.error('create_wire failed:', e); }
}

async function deleteWire(wireId) {
    try {
        await invoke('delete_wire', { id: wireId });
        wiresMap.delete(wireId);
        drawConnections();
    } catch (e) { console.error('delete_wire failed:', e); }
}

function drawPreview() {
    notesMap.forEach(({ previewG }) => { previewG.innerHTML = ''; });
    if (!dragState) return;
    const src = notesMap.get(dragState.fromId);
    if (!src) return;
    const p1s = getAnchorPos(dragState.fromId, dragState.fromSide);
    let p2s = { x: dragState.curX, y: dragState.curY };
    if (dragState.snapToId) {
        p2s = getAnchorPos(dragState.snapToId, dragState.snapToSide);
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', screenToCanvas2(p1s, p2s));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#5a2d0c');
    path.setAttribute('stroke-opacity', dragState.snapToId ? '0.55' : '0.32');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-dasharray', dragState.snapToId ? 'none' : '5 5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    src.previewG.appendChild(path);
}

function getNoteColor(noteEl) {
    return getComputedStyle(noteEl).getPropertyValue('--note-dark-color').trim() || 'hsl(0,70%,80%)';
}

function updateAnchorPositions() {
    notesMap.forEach(({ el, anchors }, id) => {
        const color = getNoteColor(el);
        ['top','bottom','left','right'].forEach(side => {
            const pos = getAnchorPos(id, side);
            const { hit, vis } = anchors[side];
            hit.setAttribute('cx', pos.x); hit.setAttribute('cy', pos.y);
            vis.setAttribute('cx', pos.x); vis.setAttribute('cy', pos.y);
            vis.setAttribute('fill', color);
        });
    });
}

function updateAnchorOpacity(mx, my) {
    notesMap.forEach(({ el, anchors }, id) => {
        let opacity;
        if (dragState) {
            opacity = (id === dragState.fromId) ? '0' : '1';
        } else {
            const r = el.getBoundingClientRect();
            const pad = 18;
            opacity = (mx >= r.left - pad && mx <= r.right + pad && my >= r.top - pad && my <= r.bottom + pad) ? '1' : '0';
        }
        const color = getNoteColor(el);
        ['top','bottom','left','right'].forEach(side => {
            const { vis } = anchors[side];
            vis.style.opacity = opacity;
            if (dragState && dragState.snapToId === id && dragState.snapToSide === side) {
                vis.setAttribute('r', '8');
                vis.setAttribute('stroke', 'rgba(0,0,0,0.55)');
                vis.setAttribute('stroke-width', '2');
            } else {
                vis.setAttribute('r', '6');
                vis.setAttribute('fill', color);
                vis.setAttribute('stroke', 'rgba(0,0,0,0.25)');
                vis.setAttribute('stroke-width', '1.5');
            }
        });
    });
}

function createAnchorDots(noteId, noteEl) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    svg.style.zIndex = noteEl.style.zIndex || zIndexCounter;
    document.body.appendChild(svg);

    const anchors = {};
    ['top','bottom','left','right'].forEach(side => {
        const vis = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        vis.setAttribute('r', '6');
        vis.setAttribute('fill', getNoteColor(noteEl));
        vis.setAttribute('stroke', 'rgba(0,0,0,0.25)');
        vis.setAttribute('stroke-width', '1.5');
        vis.style.pointerEvents = 'none';
        vis.style.opacity = '0';
        vis.style.transition = 'opacity 0.15s';
        svg.appendChild(vis);

        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        hit.setAttribute('r', '18');
        hit.setAttribute('fill', 'transparent');
        hit.setAttribute('stroke', 'none');
        hit.style.pointerEvents = 'all';
        hit.style.cursor = 'crosshair';
        hit.dataset.noteId = noteId;
        hit.dataset.side = side;

        hit.addEventListener('mouseenter', () => { if (!dragState) vis.setAttribute('r', '8'); });
        hit.addEventListener('mouseleave', () => { if (!dragState) vis.setAttribute('r', '6'); });
        hit.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            dragState = { fromId: noteId, fromSide: side, curX: e.clientX, curY: e.clientY, snapToId: null, snapToSide: null };
            document.body.classList.add('thread-dragging');
            vis.setAttribute('r', '6');
        });

        svg.appendChild(hit);
        anchors[side] = { hit, vis };
    });
    return { anchors, svg };
}

// Thread drag: mousemove
document.addEventListener('mousemove', (e) => {
    if (isPanning) return;
    updateAnchorPositions();
    if (dragState) {
        dragState.curX = e.clientX; dragState.curY = e.clientY;
        let bestDist = Infinity, bestId = null, bestSide = null;
        notesMap.forEach(({ el }, id) => {
            if (id === dragState.fromId) return;
            ['top','bottom','left','right'].forEach(side => {
                const p = getAnchorPos(id, side);
                const d = Math.hypot(e.clientX - p.x, e.clientY - p.y);
                if (d < bestDist) { bestDist = d; bestId = id; bestSide = side; }
            });
        });
        dragState.snapToId   = (bestDist <= MAGNETIC_RADIUS) ? bestId   : null;
        dragState.snapToSide = (bestDist <= MAGNETIC_RADIUS) ? bestSide : null;
        drawPreview(); drawConnections();
    }
    updateAnchorOpacity(e.clientX, e.clientY);
});

// Thread drag: mouseup
document.addEventListener('mouseup', async (e) => {
    if (!dragState) return;
    let toId   = e.target.dataset?.noteId;
    let toSide = e.target.dataset?.side;
    if (!toSide && dragState.snapToId) { toId = dragState.snapToId; toSide = dragState.snapToSide; }

    if (toId && toId !== dragState.fromId && toSide) {
        // Toggle: if wire already exists between these two nodes — delete it
        const existing = [...wiresMap.entries()].find(([, w]) =>
            (String(w.from_id) === dragState.fromId && String(w.to_id) === toId) ||
            (String(w.from_id) === toId && String(w.to_id) === dragState.fromId)
        );
        if (existing) await deleteWire(existing[0]);
        else          await onWireCreated(dragState.fromId, dragState.fromSide, toId, toSide);
    }

    const prevFromId = dragState.fromId;
    dragState = null;
    document.body.classList.remove('thread-dragging');
    notesMap.get(prevFromId)?.previewG && (notesMap.get(prevFromId).previewG.innerHTML = '');
    drawConnections();
});

// =============================================
// NOTES
// =============================================

// =============================================
// HELPERS
// =============================================

// IDs: backend returns u64 numbers; JS map keys and dataset values are strings.
// Convert to Number only when calling invoke.
function toInvokeId(id) { return Number(id); }

function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, Math.round(l * 100)];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r)      h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}

function hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))) * 255);
    return [f(0), f(8), f(4)];
}

// =============================================
// NOTE ELEMENT BUILDERS
// =============================================

function createThreadSVG(noteZ) {
    const threadSVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    threadSVG.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none;';
    threadSVG.style.zIndex = noteZ - 1;
    canvas.appendChild(threadSVG);
    const threadG  = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const previewG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    threadSVG.appendChild(threadG);
    threadSVG.appendChild(previewG);
    return { threadSVG, threadG, previewG };
}

// Shared header HTML — identical for all note types
function noteHeaderHTML() {
    return `
        <div class="note-header">
            <div class="note-title" contenteditable="false"></div>
            <div class="header-btn color-btn" title="Цвет">
                <svg viewBox="0 0 30 42"><path d="M15 3 C15 3, 3 17.5, 3 26 A 12 12 0 0 0 27 26 C 27 17.5, 15 3, 15 3 Z"/></svg>
            </div>
            <div class="header-btn delete-btn" title="Удалить"></div>
            <div class="color-palette-holder">
                <div class="color-ring-container">
                    <div class="ring-line line-outer"></div>
                    <div class="color-ring"></div>
                    <div class="color-handle"></div>
                </div>
            </div>
        </div>`;
}

function applyNoteColors(el, color) {
    const [hue, sat, lig] = rgbToHsl(color);
    el.style.setProperty('--note-base-color', `hsl(${hue}, ${sat}%, ${lig + 10}%)`);
    el.style.setProperty('--note-dark-color',  `hsl(${hue}, ${sat}%, ${lig}%)`);
    el.querySelector('.color-handle').style.transform =
        `translate(-50%, -50%) rotate(${hue - 90}deg) translate(37.5px)`;
}

// Builds the div.note for a text note
function buildNoteElement(id, x, y, w, h, color) {
    const el = document.createElement('div');
    el.className = 'note';
    el.dataset.noteId = String(id);
    el.style.left = x + 'px'; el.style.top  = y + 'px';
    el.style.width = w + 'px'; el.style.height = h + 'px';
    el.innerHTML = noteHeaderHTML() + `
        <div class="note-content-wrapper">
            <div class="note-content" contenteditable="true"></div>
        </div>`;
    applyNoteColors(el, color);
    return el;
}

// Builds the div.note for an image note
function buildImageElement(id, x, y, w, h, color) {
    const el = document.createElement('div');
    el.className = 'note note--image';
    el.dataset.noteId = String(id);
    el.style.left = x + 'px'; el.style.top  = y + 'px';
    el.style.width = w + 'px'; el.style.height = h + 'px';
    el.innerHTML = noteHeaderHTML() + `
        <div class="note-image-body">
            <img class="note-image" src="" draggable="false" alt="">
            <button class="image-copy-btn" title="Копировать">⎘</button>
        </div>
        <div class="note-image-resize-handle"></div>`;
    applyNoteColors(el, color);
    return el;
}

// Wires up all interactive events for a text note
function setupNoteEvents(el, id) {
    const noteId         = String(id);
    const noteData       = notesMap.get(noteId);
    const title          = el.querySelector('.note-title');
    const content        = el.querySelector('.note-content');
    const header         = el.querySelector('.note-header');
    const delBtn         = el.querySelector('.delete-btn');
    const colorBtn       = el.querySelector('.color-btn');
    const paletteHolder  = el.querySelector('.color-palette-holder');
    const colorRingEl    = el.querySelector('.color-ring-container');
    const colorHandle    = el.querySelector('.color-handle');

    // ── Content editing ──
    content.addEventListener('focus', () => {
        content.style.whiteSpace = 'pre-wrap';
        content.innerText = noteData.rawMarkdown || '';
    });
    content.addEventListener('blur', () => {
        noteData.rawMarkdown = content.innerText;
        content.style.whiteSpace = 'normal';
        content.innerHTML = marked.parse(noteData.rawMarkdown);
    });
    content.addEventListener('input', () => {
        saveBuffer.schedule(noteId, title.innerText, content.innerText);
    });

    // ── Title editing ──
    header.addEventListener('dblclick', (e) => {
        if (e.target.closest('.header-btn') || e.target.closest('.color-palette-holder')) return;
        title.contentEditable = 'true'; title.focus();
    });
    title.addEventListener('blur',  () => { title.contentEditable = 'false'; });
    title.addEventListener('input', () => {
        saveBuffer.schedule(noteId, title.innerText, noteData.rawMarkdown);
    });

    // ── Color picker ──
    colorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        paletteHolder.classList.toggle('active');
    });
    document.addEventListener('mousedown', (e) => {
        if (!el.contains(e.target)) paletteHolder.classList.remove('active');
    });

    let isDraggingColor = false;
    function handleColorDrag(e) {
        const rect = colorRingEl.getBoundingClientRect();
        const dx   = e.clientX - (rect.left + rect.width  / 2);
        const dy   = e.clientY - (rect.top  + rect.height / 2);
        const angleRaw = Math.atan2(dy, dx) * (180 / Math.PI);
        const hue      = Math.round(((angleRaw + 90) % 360 + 360) % 360);
        colorHandle.style.transform = `translate(-50%, -50%) rotate(${angleRaw}deg) translate(37.5px)`;
        el.style.setProperty('--note-base-color', `hsl(${hue}, 70%, 90%)`);
        el.style.setProperty('--note-dark-color',  `hsl(${hue}, 70%, 80%)`);
        return hue;
    }
    colorRingEl.addEventListener('mousedown', (e) => {
        e.stopPropagation(); isDraggingColor = true; handleColorDrag(e);
    });
    document.addEventListener('mousemove', (e) => { if (isDraggingColor) handleColorDrag(e); });
    document.addEventListener('mouseup', async (e) => {
        if (!isDraggingColor) return;
        isDraggingColor = false;
        const hue = handleColorDrag(e);
        const rgb = hslToRgb(hue, 70, 85);
        try {
            await invoke('set_color', { id: toInvokeId(noteId), color: rgb });
        } catch (e) { console.error('set_color failed:', e); }
    });

    // ── Delete ──
    delBtn.addEventListener('click', () => deleteNote(noteId));

    // ── Z-index on focus ──
    el.addEventListener('mousedown', () => {
        if (isDraggingColor) return;
        zIndexCounter += 2;
        el.style.zIndex = zIndexCounter;
        noteData.threadSVG.style.zIndex = zIndexCounter - 1;
        noteData.anchorSVG.style.zIndex = zIndexCounter;
    });
}

async function deleteNote(noteId) {
    await saveBuffer._flush(noteId);
    try {
        await invoke('delete_element', { id: toInvokeId(noteId) });
    } catch (e) { console.error('delete_element failed:', e); return; }

    for (const [wid, wire] of wiresMap) {
        if (String(wire.from_id) === noteId || String(wire.to_id) === noteId)
            wiresMap.delete(wid);
    }
    const data = notesMap.get(noteId);
    if (data) { data.el.remove(); data.anchorSVG.remove(); data.threadSVG.remove(); }
    notesMap.delete(noteId);
    drawConnections();
}

// =============================================
// IMAGE NOTES
// =============================================

function setupImageEvents(el, id) {
    const noteId = String(id);
    const noteData = notesMap.get(noteId);

    // Shared header events (color, delete, z-index) — same as text notes
    const delBtn        = el.querySelector('.delete-btn');
    const colorBtn      = el.querySelector('.color-btn');
    const paletteHolder = el.querySelector('.color-palette-holder');
    const colorRingEl   = el.querySelector('.color-ring-container');
    const colorHandle   = el.querySelector('.color-handle');

    const header = el.querySelector('.note-header');
    header.addEventListener('dblclick', (e) => {
        if (e.target.closest('.header-btn') || e.target.closest('.color-palette-holder')) return;
        const title = el.querySelector('.note-title');
        title.contentEditable = 'true'; title.focus();
    });
    const titleEncoder = new TextEncoder();
    el.querySelector('.note-title').addEventListener('beforeinput', (e) => {
        if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
            e.preventDefault();
            return;
        }
        const incoming = e.inputType === 'insertFromPaste'
            ? (e.dataTransfer?.getData('text/plain') ?? '')
            : (e.data ?? '');
        const current = e.target.innerText.trimEnd();
        if (titleEncoder.encode(current + incoming).length >= 255) e.preventDefault();
    });
    el.querySelector('.note-title').addEventListener('blur', async (e) => {
        e.target.contentEditable = 'false';
        const titleText = e.target.innerText.trimEnd();
        try {
            await invoke('update_image_title', { id: toInvokeId(id), title: titleText });
            const nd = notesMap.get(id);
            if (nd) nd.imageTitle = titleText;
        }
        catch (err) { console.error('update_image_title failed', err); }
    });

    colorBtn.addEventListener('click', (e) => { e.stopPropagation(); paletteHolder.classList.toggle('active'); });
    document.addEventListener('mousedown', (e) => { if (!el.contains(e.target)) paletteHolder.classList.remove('active'); });

    let isDraggingColor = false;
    function handleColorDrag(e) {
        const rect = colorRingEl.getBoundingClientRect();
        const angleRaw = Math.atan2(e.clientY - (rect.top + rect.height / 2), e.clientX - (rect.left + rect.width / 2)) * (180 / Math.PI);
        const hue = Math.round(((angleRaw + 90) % 360 + 360) % 360);
        colorHandle.style.transform = `translate(-50%, -50%) rotate(${angleRaw}deg) translate(37.5px)`;
        el.style.setProperty('--note-base-color', `hsl(${hue}, 70%, 90%)`);
        el.style.setProperty('--note-dark-color',  `hsl(${hue}, 70%, 80%)`);
        return hue;
    }
    colorRingEl.addEventListener('mousedown', (e) => { e.stopPropagation(); isDraggingColor = true; handleColorDrag(e); });
    document.addEventListener('mousemove', (e) => { if (isDraggingColor) handleColorDrag(e); });
    document.addEventListener('mouseup', async (e) => {
        if (!isDraggingColor) return;
        isDraggingColor = false;
        const hue = handleColorDrag(e);
        const rgb = hslToRgb(hue, 70, 85);
        try { await invoke('set_color', { id: toInvokeId(noteId), color: rgb }); }
        catch (e) { console.error('set_color failed:', e); }
    });

    delBtn.addEventListener('click', () => deleteNote(noteId));

    el.addEventListener('mousedown', () => {
        if (isDraggingColor) return;
        zIndexCounter += 2;
        el.style.zIndex = zIndexCounter;
        noteData.threadSVG.style.zIndex = zIndexCounter - 1;
        noteData.anchorSVG.style.zIndex = zIndexCounter;
    });

    // Copy button
    const copyBtn = el.querySelector('.image-copy-btn');
    copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const img = el.querySelector('.note-image');
        if (!img.src || img.src === window.location.href) return;
        try {
            const res  = await fetch(img.src);
            const blob = await res.blob();
            await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        } catch (err) { console.error('Copy image failed:', err); }
    });
}

function makeAspectResizable(el, noteId, aspectRatio) {
    const handle = el.querySelector('.note-image-resize-handle');
    let startX, startY, startW, startH;

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        startX = e.clientX; startY = e.clientY;
        startW = el.offsetWidth; startH = el.offsetHeight;

        const onMove = (e) => {
            const diag  = ((e.clientX - startX) + (e.clientY - startY)) / 2 / zoom;
            const newW  = Math.max(100, Math.round(startW + diag));
            const newH  = Math.max(60,  Math.round(30 + newW / aspectRatio));
            el.style.width  = newW + 'px';
            el.style.height = newH + 'px';
            const nd = notesMap.get(noteId);
            if (nd) { nd.slot.w = newW; nd.slot.h = newH; }
            updateAnchorPositions();
        };

        const onUp = async () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',  onUp);
            const { slot } = notesMap.get(noteId) ?? {};
            if (!slot) return;
            try { await invoke('move_element', { id: toInvokeId(noteId), x: slot.x, y: slot.y, w: slot.w, h: slot.h }); }
            catch (e) { console.error('aspect resize failed:', e); }
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',  onUp);
    });
}

async function loadImageMeta(id, noteData) {
    if (noteData.imageTitle !== null) {
        if (noteData.imageTitle) noteData.el.querySelector('.note-title').innerText = noteData.imageTitle;
        return;
    }
    try {
        const meta = await invoke('read_image_meta', { id: toInvokeId(id) });
        noteData.imageTitle = meta.title;
        if (meta.title) noteData.el.querySelector('.note-title').innerText = meta.title;
    } catch (e) { console.error('loadImageMeta failed', id, e); }
}

async function loadImageSrc(id, noteData) {
    if (noteData.srcLoaded) return;
    const key = cacheKey(id);
    const cached = imageCache.get(key);
    if (cached !== null) {
        noteData.el.querySelector('.note-image').src = cached;
        noteData.srcLoaded = true;
        return;
    }
    try {
        const img = await invoke('read_image', { id: toInvokeId(id) });
        const src = `data:${img.mime};base64,${img.data_b64}`;
        noteData.el.querySelector('.note-image').src = src;
        noteData.srcLoaded = true;
        imageCache.set(key, src);
    } catch (e) {
        console.error('loadImageSrc failed', id, e);
    }
}

function extractImageColor(mime, dataB64) {
    return new Promise(res => {
        const img = new Image();
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width = c.height = 1;
            c.getContext('2d').drawImage(img, 0, 0, 1, 1);
            const [r, g, b] = c.getContext('2d').getImageData(0, 0, 1, 1).data;
            c.width = 0;
            const [h] = rgbToHsl([r, g, b]);
            res(hslToRgb(h, 70, 85));
        };
        img.onerror = () => res(APP_CONSTANTS.DEFAULT_COLOR);
        img.src = `data:${mime};base64,${dataB64}`;
    });
}

async function createImageNote(file) {
    const dataB64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload  = () => res(reader.result.split(',')[1]);
        reader.onerror = rej;
        reader.readAsDataURL(file);
    });

    const { naturalWidth: imgW, naturalHeight: imgH } = await new Promise((res, rej) => {
        const img = new Image();
        img.onload  = () => res(img);
        img.onerror = rej;
        img.src = URL.createObjectURL(file);
    });

    const TARGET      = APP_CONSTANTS.DEFAULT_NOTE_W;
    const scale       = TARGET / Math.min(imgW, imgH);
    const noteW       = Math.round(imgW * scale);
    const noteH       = Math.round(imgH * scale) + 30;
    const aspectRatio = imgW / imgH;

    const cx = Math.round((window.innerWidth  / 2 - panX) / zoom - noteW / 2);
    const cy = Math.round((window.innerHeight / 2 - panY) / zoom - noteH / 2);
    const mime = file.type || 'image/png';

    try {
        const color = await extractImageColor(mime, dataB64);
        const id = await invoke('create_image', {
            x: cx, y: cy, w: noteW, h: noteH,
            color, mime, title: '', dataB64,
        });
        createNoteShell(
            { id, kind: 'image', x: cx, y: cy, w: noteW, h: noteH, color },
            { dataB64, mime, aspectRatio },
        );
    } catch (e) { showError('Failed to create image: ' + e); }
}

// =============================================
// SHELL ASSEMBLER
// =============================================

// imageData = { dataB64, mime, aspectRatio } — only passed for newly created images
function createNoteShell(slot, imageData = null) {
    const id    = String(slot.id);
    const kind  = slot.kind || 'note';
    zIndexCounter += 2;
    const noteZ = zIndexCounter;

    const el = kind === 'image'
        ? buildImageElement(slot.id, slot.x, slot.y, slot.w, slot.h, slot.color)
        : buildNoteElement (slot.id, slot.x, slot.y, slot.w, slot.h, slot.color);
    el.style.zIndex = noteZ;
    canvas.appendChild(el);

    const { anchors, svg: anchorSVG } = createAnchorDots(id, el);
    const { threadSVG, threadG, previewG } = createThreadSVG(noteZ);

    notesMap.set(id, {
        el, anchors, anchorSVG, threadSVG, threadG, previewG,
        kind,
        slot:        { x: slot.x, y: slot.y, w: slot.w, h: slot.h },
        rawMarkdown: '',
        bodyLoaded:  false,
        srcLoaded:   false,
        imageTitle:  null,
    });

    makeDraggable(el, id);

    if (kind === 'image') {
        const ratio = imageData?.aspectRatio ?? (slot.w / (slot.h - 30));
        makeAspectResizable(el, id, ratio);
        setupImageEvents(el, id);
        if (imageData) {
            const src = `data:${imageData.mime};base64,${imageData.dataB64}`;
            el.querySelector('.note-image').src = src;
            const nd = notesMap.get(id);
            nd.bodyLoaded  = true;
            nd.srcLoaded   = true;
            nd.imageTitle  = '';
            imageCache.set(cacheKey(id), src);
        }
    } else {
        makeResizable(el, id);
        setupNoteEvents(el, id);
    }
}

async function createNewNote() {
    const cx = Math.round((window.innerWidth  / 2 - panX) / zoom - APP_CONSTANTS.DEFAULT_NOTE_W / 2);
    const cy = Math.round((window.innerHeight / 2 - panY) / zoom - APP_CONSTANTS.DEFAULT_NOTE_H / 2);
    try {
        const id = await invoke('create_note', {
            x: cx, y: cy,
            w: APP_CONSTANTS.DEFAULT_NOTE_W,
            h: APP_CONSTANTS.DEFAULT_NOTE_H,
            title: '', body: '',
            color: APP_CONSTANTS.DEFAULT_COLOR,
        });
        createNoteShell({ id, kind: 'note', x: cx, y: cy, w: APP_CONSTANTS.DEFAULT_NOTE_W, h: APP_CONSTANTS.DEFAULT_NOTE_H, color: APP_CONSTANTS.DEFAULT_COLOR });
        notesMap.get(String(id)).bodyLoaded = true;
    } catch (e) { showError('Failed to create note: ' + e); }
}

// =============================================
// DRAG & RESIZE
// =============================================

function makeDraggable(el, noteId) {
    const header = el.querySelector('.note-header');
    let startClientX, startClientY, startWorldX, startWorldY;

    header.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.header-btn') ||
            e.target.closest('.color-palette-holder') ||
            e.target.contentEditable === 'true') return;
        e.preventDefault();

        const noteData  = notesMap.get(noteId);
        startClientX    = e.clientX;
        startClientY    = e.clientY;
        startWorldX     = noteData.slot.x;
        startWorldY     = noteData.slot.y;

        const onMove = (e) => {
            const nx = Math.round(startWorldX + (e.clientX - startClientX) / zoom);
            const ny = Math.round(startWorldY + (e.clientY - startClientY) / zoom);
            noteData.slot.x = nx;
            noteData.slot.y = ny;
            el.style.left = nx + 'px';
            el.style.top  = ny + 'px';
            updateAnchorPositions(); drawConnections();
        };

        const onUp = async () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',  onUp);
            const { slot } = notesMap.get(noteId);
            try {
                await invoke('move_element', {
                    id: toInvokeId(noteId), x: slot.x, y: slot.y, w: slot.w, h: slot.h,
                });
            } catch (e) { console.error('move_element failed:', e); }
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',  onUp);
    });
}

function makeResizable(el, noteId) {
    let resizeTimer = null;
    const observer = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        if (width <= 0 || height <= 0) return;
        const noteData = notesMap.get(noteId);
        if (!noteData) return;
        noteData.slot.w = Math.round(width);
        noteData.slot.h = Math.round(height);
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(async () => {
            const { slot } = notesMap.get(noteId) ?? {};
            if (!slot) return;
            try {
                await invoke('move_element', {
                    id: toInvokeId(noteId), x: slot.x, y: slot.y, w: slot.w, h: slot.h,
                });
            } catch (e) { console.error('resize move_element failed:', e); }
        }, 300);
    });
    observer.observe(el);
}

addBtn.addEventListener('click', createNewNote);
addImageBtn.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', () => {
    const file = imageInput.files[0];
    imageInput.value = '';
    if (file) createImageNote(file);
});

// =============================================
// VIEWPORT CULLING
// =============================================

function getViewRect() {
    const left = -panX / zoom;
    const top  = -panY / zoom;
    return { x: left, y: top, w: window.innerWidth / zoom, h: window.innerHeight / zoom };
}

function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
}

function renderNoteContent(noteData) {
    const content = noteData.el.querySelector('.note-content');
    if (!content || document.activeElement === content) return;
    content.style.whiteSpace = 'normal';
    content.innerHTML = marked.parse(noteData.rawMarkdown);
}

async function loadNoteBody(id, noteData) {
    noteData.bodyLoaded = true;
    try {
        const note = await invoke('read_note', { id: toInvokeId(id) });
        noteData.rawMarkdown = note.body;
        const titleEl = noteData.el.querySelector('.note-title');
        if (titleEl && note.title) titleEl.innerText = note.title;
        renderNoteContent(noteData);
    } catch (e) {
        console.error('loadNoteBody failed for note', id, e);
        noteData.bodyLoaded = false;
    }
}

function unloadNoteBody(noteData) {
    if (noteData.kind === 'image') {
        noteData.bodyLoaded = false;
        return;
    }
    const content = noteData.el.querySelector('.note-content');
    if (content && document.activeElement === content) return;
    noteData.bodyLoaded = false;
    noteData.rawMarkdown = '';
    if (content) content.innerHTML = '';
}

function updateVisibleNotes() {
    const viewRect = getViewRect();
    notesMap.forEach((noteData, id) => {
        const visible = rectsOverlap(noteData.slot, viewRect);
        noteData.el.style.display = visible ? '' : 'none';

        if (visible && zoom >= CULL.NOTE_BODY_MIN_ZOOM && !noteData.bodyLoaded) {
            if (noteData.kind === 'image') {
                noteData.bodyLoaded = true;
                loadImageMeta(id, noteData);
                loadImageSrc(id, noteData);
            } else {
                loadNoteBody(id, noteData);
            }
        }
        if (!visible && noteData.bodyLoaded) {
            unloadNoteBody(noteData);
        }
    });
}

window.addEventListener('resize', () => {
    updateAnchorPositions();
    updateVisibleNotes();
});

// =============================================
// SAVE BUFFER
// =============================================

class SaveBuffer {
    constructor() { this._pending = new Map(); }

    schedule(id, title, body) {
        const existing = this._pending.get(id);
        if (existing?.debounceTimer) clearTimeout(existing.debounceTimer);
        const maxTimer = existing?.maxTimer ?? setTimeout(() => this._flush(id), SAVE_BUFFER.MAX_PENDING_MS);
        const debounceTimer = setTimeout(() => this._flush(id), SAVE_BUFFER.DEBOUNCE_MS);
        this._pending.set(id, { title, body, debounceTimer, maxTimer });
    }

    async flushAll() {
        await Promise.all([...this._pending.keys()].map(id => this._flush(id)));
    }

    async _flush(id) {
        const entry = this._pending.get(id);
        if (!entry) return;
        clearTimeout(entry.debounceTimer);
        clearTimeout(entry.maxTimer);
        this._pending.delete(id);
        if (!notesMap.has(id)) return;
        try {
            await invoke('update_note_content', { id: toInvokeId(id), title: entry.title, body: entry.body });
        } catch (e) {
            console.error('SaveBuffer flush failed for note', id, e);
        }
    }
}

const saveBuffer = new SaveBuffer();

// =============================================
// PROJECT DROPDOWN
// =============================================

// -- State (populated by init_app via setupProjectDropdown) --
let projects = [];
let currentProject = '';
let dropdownOpen = false;
let addInputVisible = false;

// -- Elements --
const projRoot         = document.getElementById('proj-root');
const projSelector     = document.getElementById('proj-selector');
const projSelectorName = document.getElementById('proj-selector-name');
const projListWrap     = document.getElementById('proj-list-wrap');
const projList         = document.getElementById('proj-list');
const projAddArea      = document.getElementById('proj-add-area');
const projAddBtn       = document.getElementById('proj-add-btn');
const projAddInputRow  = document.getElementById('proj-add-input-row');
const projAddInput     = document.getElementById('proj-add-input');
const projAddConfirm   = document.getElementById('proj-add-confirm');
const projDragGhost    = document.getElementById('proj-drag-ghost');

// Hidden span for measuring text width (same font as selector)
const textMeasurer = document.createElement('span');
textMeasurer.style.cssText = 'position:fixed;top:-999px;visibility:hidden;white-space:nowrap;font:13px Segoe UI,sans-serif;';
document.body.appendChild(textMeasurer);

// Sanitize: strip forbidden filename chars silently
function sanitize(val) { return val.replace(FORBIDDEN_CHARS, ''); }

// Sync root width to fit current project name
function syncWidth() {
    textMeasurer.textContent = currentProject;
    const w = Math.max(PROJ_MIN_W, textMeasurer.offsetWidth + 38);
    projRoot.style.width = w + 'px';
}

function openDropdown() {
    dropdownOpen = true;
    projRoot.classList.add('is-open');
    projListWrap.style.display = 'flex';
    renderList();
}

function closeDropdown() {
    dropdownOpen = false;
    projRoot.classList.remove('is-open');
    projListWrap.style.display = 'none';
    hideAddInput();
}

function hideAddInput() {
    addInputVisible = false;
    projAddInputRow.style.display = 'none';
    projAddBtn.style.display = 'block';
    projAddInput.value = '';
}

// Render visible items (excludes currentProject)
function renderList() {
    projList.innerHTML = '';
    projects.forEach((name, realIdx) => {
        if (name === currentProject) return;
        appendItem(name, realIdx);
    });
}

// Build and attach a single list item
function appendItem(name, realIdx) {
    const item = document.createElement('div');
    item.className = 'proj-item';
    item.dataset.name = name;
    item.dataset.realIdx = realIdx;

    const nameEl = document.createElement('span');
    nameEl.className = 'proj-item-name';
    nameEl.textContent = name;

    const btns = document.createElement('div');
    btns.className = 'proj-item-btns';

    const editBtn = document.createElement('div');
    editBtn.className = 'proj-item-btn';
    editBtn.innerHTML = '&#9998;';
    editBtn.title = 'Переименовать';

    const delBtn = document.createElement('div');
    delBtn.className = 'proj-item-btn is-del';
    delBtn.innerHTML = '&#10005;';
    delBtn.title = 'Удалить';

    btns.appendChild(editBtn);
    btns.appendChild(delBtn);
    item.appendChild(nameEl);
    item.appendChild(btns);
    projList.appendChild(item);

    // Click item → switch project
    item.addEventListener('click', async (e) => {
        if (e.target.closest('.proj-item-btns') || e.target.closest('.proj-item-edit-row')) return;
        if (dndState && dndState.dragging) return;
        closeDropdown();
        await switchProject(name);
    });

    // Pencil → start rename
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startItemEdit(item, realIdx, name);
    });

    // Delete → remove from array, re-render
    delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onDeleteProject(name);
    });

    // Drag-to-sort
    setupItemDrag(item);
}

// In-place rename for an existing item
function startItemEdit(item, realIdx, oldName) {
    item.innerHTML = '';
    item.style.cursor = 'default';

    const row = document.createElement('div');
    row.className = 'proj-item-edit-row';

    const input = document.createElement('input');
    input.className = 'proj-item-edit-input';
    input.value = oldName;
    input.autocomplete = 'off';

    const confirmBtn = document.createElement('div');
    confirmBtn.className = 'proj-confirm-btn';
    confirmBtn.innerHTML = '<svg width="10" height="8" viewBox="0 0 10 8" fill="none"><polyline points="1,4 3.8,7 9,1" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    confirmBtn.title = 'Сохранить';

    row.appendChild(input);
    row.appendChild(confirmBtn);
    item.appendChild(row);
    input.focus();
    input.select();

    input.addEventListener('input', () => {
        const clean = sanitize(input.value);
        if (clean !== input.value) {
            const pos = Math.max(0, input.selectionStart - (input.value.length - clean.length));
            input.value = clean;
            input.setSelectionRange(pos, pos);
        }
    });

    let saved = false;
    function tryConfirmEdit() {
        if (saved) return;
        saved = true;
        const val = input.value.trim();
        if (val && val !== oldName && !projects.includes(val)) {
            onRenameProject(oldName, val);
        } else {
            renderList();
        }
    }

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); tryConfirmEdit(); }
        if (e.key === 'Escape') { saved = true; renderList(); }
    });
    input.addEventListener('blur', () => setTimeout(tryConfirmEdit, 80));
    confirmBtn.addEventListener('mousedown', (e) => { e.preventDefault(); });
    confirmBtn.addEventListener('click', tryConfirmEdit);
}

// ===== Add-input logic =====

projAddBtn.addEventListener('click', () => {
    addInputVisible = true;
    projAddBtn.style.display = 'none';
    projAddInputRow.style.display = 'flex';
    projAddInput.value = '';
    projAddInput.focus();
});

projAddInput.addEventListener('input', () => {
    const clean = sanitize(projAddInput.value);
    if (clean !== projAddInput.value) {
        const pos = Math.max(0, projAddInput.selectionStart - (projAddInput.value.length - clean.length));
        projAddInput.value = clean;
        projAddInput.setSelectionRange(pos, pos);
    }
});

function tryAddProject() {
    const val = projAddInput.value.trim();
    hideAddInput();
    if (val && !projects.includes(val)) onAddProject(val);
}

projAddInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); tryAddProject(); }
    if (e.key === 'Escape') hideAddInput();
});
projAddInput.addEventListener('blur', () => {
    if (addInputVisible) setTimeout(tryAddProject, 80);
});
projAddConfirm.addEventListener('mousedown', (e) => { e.preventDefault(); });
projAddConfirm.addEventListener('click', tryAddProject);

// ===== Open/close =====

projSelector.addEventListener('click', () => {
    if (dropdownOpen) closeDropdown();
    else openDropdown();
});

document.addEventListener('mousedown', (e) => {
    if (!dropdownOpen) return;
    if (projRoot.contains(e.target)) return;
    if (projRoot.querySelector('input:focus')) return;
    closeDropdown();
});

// =============================================
// DRAG-TO-SORT
// =============================================

let dndState = null;
let dndScrollRAF = null;

function setupItemDrag(item) {
    item.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.proj-item-btns') || e.target.closest('.proj-item-edit-row')) return;

        dndState = {
            srcEl: item,
            srcName: item.dataset.name,
            startX: e.clientX,
            startY: e.clientY,
            dragging: false,
            insertBeforeName: null
        };

        const onMove = (e) => {
            if (!dndState) return;
            const dist = Math.hypot(e.clientX - dndState.startX, e.clientY - dndState.startY);

            if (!dndState.dragging && dist > 5) {
                dndState.dragging = true;
                dndState.srcEl.classList.add('is-ghost');
                projDragGhost.textContent = dndState.srcName;
                projDragGhost.style.width  = projRoot.offsetWidth + 'px';
                projDragGhost.style.display = 'block';
            }

            if (dndState.dragging) {
                projDragGhost.style.left = projRoot.getBoundingClientRect().left + 'px';
                projDragGhost.style.top  = (e.clientY - 15) + 'px';
                updateDragOverIndicator(e.clientY);
                startAutoScroll(e.clientY);
            }
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            stopAutoScroll();

            if (dndState && dndState.dragging) {
                dndState.srcEl.classList.remove('is-ghost');
                projDragGhost.style.display = 'none';
                clearDragIndicators();
                applyDrop();
            }
            dndState = null;
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function clearDragIndicators() {
    projList.querySelectorAll('.drag-above, .drag-below').forEach(el => {
        el.classList.remove('drag-above', 'drag-below');
    });
}

function updateDragOverIndicator(clientY) {
    if (!dndState) return;
    clearDragIndicators();
    const items = [...projList.querySelectorAll('.proj-item:not(.is-ghost)')];
    if (!items.length) { dndState.insertBeforeName = null; return; }

    for (const el of items) {
        const rect = el.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
            el.classList.add('drag-above');
            dndState.insertBeforeName = el.dataset.name;
            return;
        }
    }
    items[items.length - 1].classList.add('drag-below');
    dndState.insertBeforeName = null;
}

function startAutoScroll(clientY) {
    stopAutoScroll();
    const rect = projList.getBoundingClientRect();
    const ZONE = 28, SPEED = 5;
    let dir = 0;
    if (clientY < rect.top + ZONE)        dir = -1;
    else if (clientY > rect.bottom - ZONE) dir = 1;
    if (dir === 0) return;
    function step() {
        projList.scrollTop += dir * SPEED;
        dndScrollRAF = requestAnimationFrame(step);
    }
    dndScrollRAF = requestAnimationFrame(step);
}

function stopAutoScroll() {
    if (dndScrollRAF) { cancelAnimationFrame(dndScrollRAF); dndScrollRAF = null; }
}

function applyDrop() {
    if (!dndState) return;
    const srcName = dndState.srcName;
    const allItems = [...projList.querySelectorAll('.proj-item')];
    const otherNames = allItems.filter(el => el !== dndState.srcEl).map(el => el.dataset.name);

    let insertIdx;
    if (!dndState.insertBeforeName) {
        insertIdx = otherNames.length;
    } else {
        insertIdx = otherNames.indexOf(dndState.insertBeforeName);
        if (insertIdx === -1) insertIdx = otherNames.length;
    }
    otherNames.splice(insertIdx, 0, srcName);

    projects = [currentProject, ...otherNames];
    renderList();
}

// =============================================
// PROJECT SWITCHING & WINDOW CLOSE
// =============================================

function clearCanvas() {
    notesMap.forEach(({ el, anchorSVG, threadSVG }) => {
        el.remove(); anchorSVG.remove(); threadSVG.remove();
    });
    notesMap.clear();
    wiresMap.clear();
    saveBuffer.flushAll();
}

async function loadCurrentProject() {
    clearCanvas();
    try {
        const data = await invoke('get_project_data');
        for (const slot of data.slots) {
            createNoteShell(slot);
        }
        for (const wire of data.wires) {
            wiresMap.set(wire.id, wire);
        }
        drawConnections();
        updateVisibleNotes();
    } catch (e) {
        showError('Failed to load project: ' + e);
    }
}

async function onAddProject(name) {
    try {
        await saveBuffer.flushAll();
        await invoke('create_project', { name });
        projects.push(name);
        currentProject = name;
        projSelectorName.textContent = name;
        syncWidth();
        renderList();
        await loadCurrentProject();
        closeDropdown();
    } catch (e) { showError(String(e)); }
}

async function onRenameProject(oldName, newName) {
    try {
        await invoke('rename_project', { oldName, newName });
        imageCache.invalidateProject(oldName);
        const idx = projects.indexOf(oldName);
        if (idx >= 0) projects[idx] = newName;
        if (currentProject === oldName) {
            currentProject = newName;
            projSelectorName.textContent = newName;
            syncWidth();
        }
        renderList();
    } catch (e) { showError(String(e)); }
}

async function onDeleteProject(name) {
    try {
        const result = await invoke('delete_project', { name });
        projects      = result.projects;
        currentProject = result.current;
        projSelectorName.textContent = result.current;
        syncWidth();
        renderList();
    } catch (e) { showError(String(e)); }
}

function setupProjectDropdown(projectsList, current) {
    projects       = projectsList;
    currentProject = current;
    projSelectorName.textContent = current;
    syncWidth();
    renderList();
}

async function switchProject(name) {
    await saveBuffer.flushAll();
    await invoke('flush');
    await invoke('switch_project', { name });
    currentProject = name;
    projSelectorName.textContent = name;
    syncWidth();
    renderList();
    await loadCurrentProject();
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const init = await invoke('init_app');
        setupProjectDropdown(init.projects, init.current);
        await loadCurrentProject();
    } catch (e) {
        showError('Failed to initialize: ' + e);
    }
});

window.addEventListener('blur', async () => {
    await saveBuffer.flushAll();
    await invoke('flush');
});

// onCloseRequested removed