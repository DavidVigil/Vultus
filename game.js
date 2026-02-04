// === CONFIGURACIÓN INICIAL ===
let scene, camera, renderer, mask;
let mainLight;
let selectedColor = '#ff0000';
let isPaintMode = true;

// Estados del Mouse / Touch
let isMouseDown = false;       
let isRightMouseDown = false;  
let previousMousePosition = { x: 0, y: 0 };

// Variables Táctiles
let initialPinchDistance = 0;
let isPinching = false;
let lastPanPosition = { x: 0, y: 0 };

const BASE_MASK_COLOR = '#dddddd';

// Audio
let backgroundMusic;
const sfx = {
    click: null,
    hover: null,
    appear: null
};

// Loaders
let objLoader, textureLoader;

// Sistema de pintura
let paintCanvas, paintContext, paintTexture;
let brushSize = 25;
let lastPaintPosition = null;

// Sistema de historial
let paintHistory = [];
let paintRedoStack = [];
let maxHistorySize = 20;

// Estado de Máscaras y Progresión
let currentModelName = 'mask';
let maskStates = {}; 
let userProgress = { unlockedMasks: 1, gallery: [] };
const MASK_ORDER = ['mask', 'mask2', 'mask3']; 

// Animación
let isEntryAnimation = false;
let animationProgress = 0;
const ANIMATION_SPEED = 0.02;

// === 1. FUNCIONES UTILITARIAS ===

function detectDevice() {
    const isTouch = (('ontouchstart' in window) || (navigator.maxTouchPoints > 0));
    if (isTouch) {
        document.body.classList.add('is-touch');
    }
}

function loadProgress() {
    const saved = localStorage.getItem('maskPainterProgress');
    if (saved) userProgress = JSON.parse(saved);
}

function saveProgress() {
    localStorage.setItem('maskPainterProgress', JSON.stringify(userProgress));
}

function setupAudio() {
    backgroundMusic = new Audio('assets/audio/background.mp3');
    backgroundMusic.loop = true;
    backgroundMusic.volume = 0.3;
    
    sfx.click = new Audio('assets/audio/click.ogg');
    sfx.hover = new Audio('assets/audio/hover.ogg');
    sfx.appear = new Audio('assets/audio/appear.ogg');

    if(sfx.click) sfx.click.volume = 0.6;
    if(sfx.hover) sfx.hover.volume = 0.2;
    if(sfx.appear) sfx.appear.volume = 0.5;

    document.addEventListener('click', () => backgroundMusic.play().catch(()=>{}), { once: true });
}

function playSound(type) {
    if (sfx[type]) {
        const soundClone = sfx[type].cloneNode(); 
        soundClone.volume = sfx[type].volume;
        soundClone.play().catch(() => {});
    }
}

// === 2. FUNCIONES DE HISTORIAL Y CANVAS ===

function updateHistoryButtons() {
    const undoBtn = document.getElementById('undoButton');
    const redoBtn = document.getElementById('redoButton');
    if(undoBtn) undoBtn.classList.toggle('disabled', paintHistory.length <= 1);
    if(redoBtn) redoBtn.classList.toggle('disabled', paintRedoStack.length === 0);
}

function saveCanvasState() {
    if (!paintContext) return;
    const imageData = paintContext.getImageData(0, 0, paintCanvas.width, paintCanvas.height);
    paintHistory.push(imageData);
    paintRedoStack = [];
    if (paintHistory.length > maxHistorySize) paintHistory.shift();
    updateHistoryButtons();
}

function undo() {
    if (paintHistory.length <= 1) return;
    const currentState = paintHistory.pop();
    paintRedoStack.push(currentState);
    const previousState = paintHistory[paintHistory.length - 1];
    paintContext.putImageData(previousState, 0, 0);
    paintTexture.needsUpdate = true;
    updateHistoryButtons();
}

function redo() {
    if (paintRedoStack.length === 0) return;
    const nextState = paintRedoStack.pop();
    paintHistory.push(nextState);
    paintContext.putImageData(nextState, 0, 0);
    paintTexture.needsUpdate = true;
    updateHistoryButtons();
}

function createPaintCanvas() {
    paintCanvas = document.createElement('canvas');
    paintCanvas.width = 2048;
    paintCanvas.height = 2048;
    paintContext = paintCanvas.getContext('2d', { willReadFrequently: true });
    
    paintContext.fillStyle = BASE_MASK_COLOR;
    paintContext.fillRect(0, 0, paintCanvas.width, paintCanvas.height);
    
    paintTexture = new THREE.CanvasTexture(paintCanvas);
    paintTexture.needsUpdate = true;
    
    saveCanvasState();
}

// === 3. FUNCIONES DE MÁSCARA ===

function saveCurrentMaskState() {
    const currentPixels = paintContext.getImageData(0, 0, paintCanvas.width, paintCanvas.height);
    maskStates[currentModelName] = { imageData: currentPixels, history: [...paintHistory], redoStack: [...paintRedoStack] };
}

function restoreMaskState(modelName) {
    currentModelName = modelName;
    if (maskStates[modelName]) {
        const state = maskStates[modelName];
        paintContext.putImageData(state.imageData, 0, 0);
        paintHistory = [...state.history];
        paintRedoStack = state.redoStack ? [...state.redoStack] : [];
    } else {
        paintContext.fillStyle = BASE_MASK_COLOR;
        paintContext.fillRect(0, 0, paintCanvas.width, paintCanvas.height);
        paintHistory = [];
        paintRedoStack = [];
        saveCanvasState();
    }
    if (paintTexture) paintTexture.needsUpdate = true;
    updateHistoryButtons();
}

function loadMaskModel(modelName) {
    saveCurrentMaskState();
    if (mask) {
        scene.remove(mask);
        mask.traverse((c) => { if(c.isMesh) { c.geometry.dispose(); if(c.material.map && c.material.map !== paintTexture) c.material.map.dispose(); } });
        mask = null;
    }
    restoreMaskState(modelName);
    
    const manager = new THREE.LoadingManager();
    textureLoader = new THREE.TextureLoader(manager);
    textureLoader.setCrossOrigin('anonymous');
    
    const material = new THREE.MeshStandardMaterial({ map: paintTexture, aoMapIntensity: 1.0, metalness: 0.1, roughness: 0.5, side: THREE.DoubleSide });
    
    const loadOptionalTexture = (type, path) => {
        const relativePath = path.startsWith('assets') ? './' + path : path;
        textureLoader.load(relativePath, (t) => { material[type] = t; material.needsUpdate = true; }, undefined, () => {});
    };
    
    loadOptionalTexture('normalMap', `assets/models/${modelName}_normal.png`);
    loadOptionalTexture('aoMap', `assets/models/${modelName}_ao.png`);
    loadOptionalTexture('roughnessMap', `assets/models/${modelName}_roughness.png`);
    
    const loader = new THREE.OBJLoader(manager);
    loader.load(`assets/models/${modelName}.obj`, function (object) {
        const maskGroup = new THREE.Group();
        object.traverse(function (child) { if (child instanceof THREE.Mesh) child.material = material; });
        
        const box = new THREE.Box3().setFromObject(object);
        const center = box.getCenter(new THREE.Vector3());
        object.position.sub(center);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        object.scale.multiplyScalar(3 / maxDim);

        maskGroup.add(object);
        mask = maskGroup;
        scene.add(maskGroup);
        
        isEntryAnimation = true; animationProgress = 0; mask.scale.set(0, 0, 0); 
        playSound('appear');
    }, undefined, (e) => {
        console.error(e);
        createFallbackSphere();
    });
}

function createFallbackSphere() {
    const geometry = new THREE.SphereGeometry(2, 64, 64);
    const material = new THREE.MeshStandardMaterial({ map: paintTexture });
    mask = new THREE.Mesh(geometry, material);
    scene.add(mask);
    isEntryAnimation = true; animationProgress = 0; mask.scale.set(0, 0, 0); 
    playSound('appear');
}

// === 4. UI Y CONTROLES ===

function togglePaintMode() {
    isPaintMode = !isPaintMode;
    const canvas = document.getElementById('gameCanvas');
    const mobileBtn = document.getElementById('mobileModeToggle');
    
    if (isPaintMode) {
        canvas.style.cursor = 'crosshair';
        if(mobileBtn) mobileBtn.textContent = '🔄'; 
    } else {
        canvas.style.cursor = 'move';
        if(mobileBtn) mobileBtn.textContent = '🎨'; 
    }
    playSound('hover'); 
    changeBackground();
}

function setupUIControls() {
    document.getElementById('undoButton').addEventListener('click', undo);
    document.getElementById('redoButton').addEventListener('click', redo);
    
    const mobileBtn = document.getElementById('mobileModeToggle');
    if(mobileBtn) mobileBtn.addEventListener('click', togglePaintMode);

    document.getElementById('lightToggle').addEventListener('click', () => {
        const x = Math.abs(mainLight.position.x);
        mainLight.position.x = (mainLight.position.x > 0) ? -x : x;
    });

    document.getElementById('clearButton').addEventListener('click', () => {
        playSound('click');
        if (confirm('¿Borrar todo?')) {
            paintContext.fillStyle = BASE_MASK_COLOR;
            paintContext.fillRect(0, 0, paintCanvas.width, paintCanvas.height);
            paintTexture.needsUpdate = true;
            paintHistory = []; paintRedoStack = [];
            saveCanvasState();
        }
    });

    document.getElementById('paletteToggle').addEventListener('click', () => {
        document.getElementById('colorPalette').classList.toggle('open');
        document.getElementById('maskSelector').classList.remove('open');
    });
    document.getElementById('maskToggle').addEventListener('click', () => {
        document.getElementById('maskSelector').classList.toggle('open');
        document.getElementById('colorPalette').classList.remove('open');
    });
    document.getElementById('brushSizeSlider').addEventListener('input', (e) => {
        brushSize = parseInt(e.target.value);
        document.getElementById('brushSizeValue').textContent = brushSize;
    });
    document.getElementById('musicToggle').addEventListener('click', (e) => {
        if (backgroundMusic.paused) {
            backgroundMusic.play();
            e.target.textContent = '🔊';
        } else {
            backgroundMusic.pause();
            e.target.textContent = '🔇';
        }
    });
}

function setupColorMixing() {
    const picker = document.getElementById('colorPicker');
    selectedColor = picker.value;
    picker.addEventListener('input', (e) => selectedColor = e.target.value);
}

function setupUISounds() {
    const elements = document.querySelectorAll('.control-btn, .mask-item, #saveButton, #galleryButton');
    elements.forEach(el => {
        el.addEventListener('click', () => playSound('click'));
        el.addEventListener('mouseenter', () => playSound('hover'));
    });
}

function renderMaskSelector() {
    const container = document.getElementById('maskListContainer');
    container.innerHTML = '';
    MASK_ORDER.forEach((m, i) => {
        const div = document.createElement('div');
        div.className = `mask-item ${m === currentModelName ? 'selected' : ''}`;
        if ((i + 1) > userProgress.unlockedMasks) div.classList.add('locked');
        else div.classList.add('interactive-ui');
        
        const img = document.createElement('img');
        img.src = `assets/masks/mask${i + 1}_preview.jpg`;
        div.appendChild(img);
        
        div.addEventListener('click', () => {
            if (!div.classList.contains('locked')) {
                document.querySelectorAll('.mask-item').forEach(el => el.classList.remove('selected'));
                div.classList.add('selected');
                loadMaskModel(m);
            }
        });
        container.appendChild(div);
    });
    setupUISounds();
}

// === 5. UTILS DE PINTURA ===
function paintAtPosition(x, y) {
    const mouse = new THREE.Vector2((x/window.innerWidth)*2-1, -(y/window.innerHeight)*2+1);
    const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(mask.children, true);
    if (intersects.length > 0) {
        const uv = intersects[0].uv;
        if (uv) {
            const canvasX = uv.x * paintCanvas.width; const canvasY = (1 - uv.y) * paintCanvas.height;
            if (lastPaintPosition) interpolatePaint(lastPaintPosition.x, lastPaintPosition.y, canvasX, canvasY);
            else drawBrush(canvasX, canvasY);
            lastPaintPosition = { x: canvasX, y: canvasY }; paintTexture.needsUpdate = true;
        }
    }
}

function drawBrush(x, y) {
    paintContext.globalCompositeOperation = 'source-over';
    const gradient = paintContext.createRadialGradient(x, y, 0, x, y, brushSize);
    gradient.addColorStop(0, selectedColor); gradient.addColorStop(0.5, selectedColor + 'DD'); gradient.addColorStop(1, selectedColor + '00');
    paintContext.fillStyle = gradient; paintContext.beginPath(); paintContext.arc(x, y, brushSize, 0, Math.PI * 2); paintContext.fill();
}

function interpolatePaint(x1, y1, x2, y2) {
    const d = Math.sqrt((x2-x1)**2 + (y2-y1)**2);
    const steps = Math.max(1, Math.ceil(d / (brushSize * 0.25)));
    for (let i = 0; i <= steps; i++) { const t = i/steps; drawBrush(x1 + (x2-x1)*t, y1 + (y2-y1)*t); }
}

// === 6. INPUT HANDLERS (AQUÍ ESTABA EL ERROR: AHORA INCLUIDOS) ===

function setupEventListeners() {
    const canvas = document.getElementById('gameCanvas');
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseUp);
    canvas.addEventListener('wheel', onMouseWheel, { passive: false });

    // Touch
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd);

    window.addEventListener('resize', onWindowResize);
    document.addEventListener('keydown', onKeyDown);
}

// --- MOUSE ---
function onMouseDown(e) {
    if (isEntryAnimation) return;
    if (e.button === 0) {
        isMouseDown = true; previousMousePosition = { x: e.clientX, y: e.clientY };
        if (isPaintMode) paintAtPosition(e.clientX, e.clientY);
    } else if (e.button === 2) {
        isRightMouseDown = true; previousMousePosition = { x: e.clientX, y: e.clientY };
        document.getElementById('gameCanvas').style.cursor = 'grabbing';
    }
}

function onMouseMove(e) {
    if (isEntryAnimation) return;
    if (isPaintMode && isMouseDown) {
        paintAtPosition(e.clientX, e.clientY);
    } else {
        const deltaX = e.clientX - previousMousePosition.x;
        const deltaY = e.clientY - previousMousePosition.y;
        if (isMouseDown && !isPaintMode) { 
            mask.rotation.y += deltaX * 0.01; mask.rotation.x += deltaY * 0.01;
        } else if (isRightMouseDown) {
            mask.position.x += deltaX * 0.01; mask.position.y -= deltaY * 0.01;
            mask.position.x = Math.max(-3, Math.min(3, mask.position.x));
            mask.position.y = Math.max(-2, Math.min(2, mask.position.y));
        }
        previousMousePosition = { x: e.clientX, y: e.clientY };
    }
}

function onMouseUp() {
    isMouseDown = false; isRightMouseDown = false; lastPaintPosition = null;
    document.getElementById('gameCanvas').style.cursor = isPaintMode ? 'crosshair' : 'move';
    if (isPaintMode && !isEntryAnimation) saveCanvasState();
}

// --- TOUCH ---
function onTouchStart(e) {
    if (isEntryAnimation) return;
    e.preventDefault();

    if (e.touches.length === 1) {
        isMouseDown = true; isPinching = false;
        previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        if (isPaintMode) paintAtPosition(e.touches[0].clientX, e.touches[0].clientY);
    } else if (e.touches.length === 2) {
        isMouseDown = false; isPinching = true;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        initialPinchDistance = Math.sqrt(dx*dx + dy*dy);
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        lastPanPosition = { x: midX, y: midY };
    }
}

function onTouchMove(e) {
    if (isEntryAnimation) return;
    e.preventDefault();

    if (e.touches.length === 1 && !isPinching) {
        if (isPaintMode) {
            paintAtPosition(e.touches[0].clientX, e.touches[0].clientY);
        } else {
            const deltaX = e.touches[0].clientX - previousMousePosition.x;
            const deltaY = e.touches[0].clientY - previousMousePosition.y;
            mask.rotation.y += deltaX * 0.01;
            mask.rotation.x += deltaY * 0.01;
            previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
    } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const currentDist = Math.sqrt(dx*dx + dy*dy);
        const zoomDelta = (initialPinchDistance - currentDist) * 0.01;
        camera.position.z = Math.max(0.5, Math.min(10, camera.position.z + zoomDelta));
        initialPinchDistance = currentDist;

        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const panX = (midX - lastPanPosition.x) * 0.01;
        const panY = (midY - lastPanPosition.y) * 0.01;
        mask.position.x = Math.max(-3, Math.min(3, mask.position.x + panX));
        mask.position.y = Math.max(-2, Math.min(2, mask.position.y - panY));
        lastPanPosition = { x: midX, y: midY };
    }
}

function onTouchEnd(e) {
    if (e.touches.length === 0) {
        isMouseDown = false; isPinching = false; lastPaintPosition = null;
        if (isPaintMode && !isEntryAnimation) saveCanvasState();
    }
}

// === 7. OTROS UTILS ===

function changeBackground() {
    const bg1 = document.getElementById('backgroundImage1');
    const bg2 = document.getElementById('backgroundImage2');
    if (bg1.classList.contains('active')) { bg1.classList.remove('active'); bg2.classList.add('active'); } 
    else { bg2.classList.remove('active'); bg1.classList.add('active'); }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function onMouseWheel(e) {
    e.preventDefault();
    if (e.deltaY < 0) camera.position.z = Math.max(0.5, camera.position.z - 0.3);
    else camera.position.z = Math.min(10, camera.position.z + 0.1);
}

function onKeyDown(e) {
    if(e.target.tagName.match(/INPUT|TEXTAREA/)) return;
    if(e.code === 'Space') { e.preventDefault(); togglePaintMode(); }
    if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z' && !e.shiftKey) { e.preventDefault(); undo(); }
    if((e.ctrlKey||e.metaKey) && (e.key.toLowerCase()==='y' || (e.shiftKey && e.key.toLowerCase()==='z'))) { e.preventDefault(); redo(); }
}

function animate() {
    requestAnimationFrame(animate);
    if (mask && isEntryAnimation) {
        animationProgress += ANIMATION_SPEED;
        if (animationProgress >= 1) { animationProgress = 1; isEntryAnimation = false; mask.scale.set(1, 1, 1); mask.rotation.set(0, 0, 0); mask.position.set(0, 0, 0); } 
        else { const scale = animationProgress; mask.scale.set(scale, scale, scale); mask.rotation.y = animationProgress * Math.PI * 4; }
    }
    renderer.render(scene, camera);
}

// === 8. GALERÍA (Lógica Cuadrada) ===

function setupSaveAndGallerySystem() {
    document.getElementById('saveButton').addEventListener('click', () => document.getElementById('saveModal').classList.add('open'));
    document.getElementById('cancelSave').addEventListener('click', () => document.getElementById('saveModal').classList.remove('open'));
    document.getElementById('confirmSave').addEventListener('click', () => {
        saveDesignToGallery(document.getElementById('designName').value, '');
        document.getElementById('saveModal').classList.remove('open');
    });
    document.getElementById('galleryButton').addEventListener('click', () => { updateGalleryUI(); document.getElementById('galleryModal').classList.add('open'); });
    document.getElementById('closeGallery').addEventListener('click', () => document.getElementById('galleryModal').classList.remove('open'));
}

function saveDesignToGallery(name, desc) {
    renderer.render(scene, camera);
    
    // Canvas temporal cuadrado
    const tempCanvas = document.createElement('canvas');
    const size = 512;
    tempCanvas.width = size;
    tempCanvas.height = size;
    const ctx = tempCanvas.getContext('2d');
    
    const canvas = renderer.domElement;
    const w = canvas.width;
    const h = canvas.height;
    const minDim = Math.min(w, h);
    const startX = (w - minDim) / 2;
    const startY = (h - minDim) / 2;
    
    ctx.drawImage(canvas, startX, startY, minDim, minDim, 0, 0, size, size);
    
    const imageDataURL = tempCanvas.toDataURL('image/png');
    
    userProgress.gallery.unshift({ id: Date.now(), maskModel: currentModelName, name, image: imageDataURL, date: new Date().toLocaleDateString() });
    
    const idx = MASK_ORDER.indexOf(currentModelName);
    if (idx + 1 === userProgress.unlockedMasks && userProgress.unlockedMasks < MASK_ORDER.length) {
        userProgress.unlockedMasks++; renderMaskSelector();
    }
    saveProgress(); 
    const t = document.getElementById("toast"); t.className = "show"; setTimeout(() => t.className = "", 3000);
}

function updateGalleryUI() {
    const g = document.getElementById('galleryGrid'); g.innerHTML = '';
    userProgress.gallery.forEach(i => {
        const d = document.createElement('div'); d.className = 'gallery-item';
        d.innerHTML = `<div class="gallery-img-container"><img src="${i.image}" alt="${i.name}"></div><h4>${i.name}</h4><small>${i.maskModel} - ${i.date}</small>`;
        
        const del = document.createElement('div'); del.className = 'delete-card-btn'; del.textContent = '×';
        del.onclick = (e) => { e.stopPropagation(); playSound('click'); if(confirm('¿Borrar?')) { userProgress.gallery = userProgress.gallery.filter(x => x.id !== i.id); saveProgress(); updateGalleryUI(); }};
        d.appendChild(del);
        
        const shareBtn = document.createElement('button');
        shareBtn.className = 'share-insta-btn';
        shareBtn.textContent = '📸 Compartir';
        shareBtn.onclick = () => { playSound('click'); handleInstagramShare(i.image, i.name); };
        d.appendChild(shareBtn);
        
        g.appendChild(d);
    });
}

async function handleInstagramShare(base64Image, title) {
    const file = await dataURLtoFile(base64Image, 'mi_mascara.png');
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'Mi Diseño', text: `¡Mira mi diseño "${title}"!` }); } catch (error) { console.log('Error', error); }
    } else {
        const link = document.createElement('a'); link.href = base64Image; link.download = `mask_${title.replace(/\s+/g, '_')}.png`;
        document.body.appendChild(link); link.click(); document.body.removeChild(link);
        const t = document.getElementById("toast"); t.textContent = "Descargando imagen..."; t.className = "show"; setTimeout(() => t.className = "", 3000);
    }
}

async function dataURLtoFile(dataurl, filename) {
    const arr = dataurl.split(','); const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]); let n = bstr.length; const u8arr = new Uint8Array(n);
    while(n--){ u8arr[n] = bstr.charCodeAt(n); }
    return new File([u8arr], filename, {type:mime});
}

function deleteGalleryItem(id) {
    if (confirm('¿Eliminar?')) { userProgress.gallery = userProgress.gallery.filter(item => item.id !== id); saveProgress(); updateGalleryUI(); }
}

// === 9. INICIAR (DEFINIDA AL FINAL) ===
function init() {
    loadProgress(); 
    detectDevice();

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 5;

    const canvas = document.getElementById('gameCanvas');
    canvas.style.cursor = 'crosshair';

    renderer = new THREE.WebGLRenderer({ 
        canvas: canvas, antialias: true, alpha: true, preserveDrawingBuffer: true 
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0);
    renderer.outputEncoding = THREE.sRGBEncoding;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);
    mainLight = new THREE.DirectionalLight(0xffffff, 1);
    mainLight.position.set(5, 5, 5);
    scene.add(mainLight);

    createPaintCanvas(); 
    renderMaskSelector();
    setupAudio(); 
    loadMaskModel(currentModelName); 
    setupEventListeners(); // Ahora esta función ya existe arriba
    setupUIControls();
    
    setupColorMixing();
    setupSaveAndGallerySystem();
    
    animate();
}

// Ejecutar
init();