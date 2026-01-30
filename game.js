// === CONFIGURACIÓN INICIAL ===
let scene, camera, renderer, mask;
let mainLight;
let selectedColor = '#ff0000';
let isPaintMode = true;

// Estados del Mouse
let isMouseDown = false;       
let isRightMouseDown = false;  
let previousMousePosition = { x: 0, y: 0 };

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

// Sistema de historial (Deshacer/Rehacer)
let paintHistory = [];
let paintRedoStack = [];
let maxHistorySize = 20;

// Estado de Máscaras y Progresión
let currentModelName = 'mask';
let maskStates = {}; 
let userProgress = {
    unlockedMasks: 1, 
    gallery: [] 
};
const MASK_ORDER = ['mask', 'mask2', 'mask3']; 

// Variables de Animación de Entrada
let isEntryAnimation = false;
let animationProgress = 0;
const ANIMATION_SPEED = 0.02;

// === INICIALIZACIÓN ===
function init() {
    loadProgress(); 

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 5;

    const canvas = document.getElementById('gameCanvas');
    canvas.style.cursor = 'crosshair';

    renderer = new THREE.WebGLRenderer({ 
        canvas: canvas, 
        antialias: true, 
        alpha: true,
        preserveDrawingBuffer: true 
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
    setupAudio(); // Cargamos música y efectos
    loadMaskModel(currentModelName); // Aquí sonará el efecto 'appear'
    setupEventListeners();
    animate();
}

// === GESTIÓN DE PROGRESO ===
function loadProgress() {
    const saved = localStorage.getItem('maskPainterProgress');
    if (saved) {
        userProgress = JSON.parse(saved);
    }
}

function saveProgress() {
    localStorage.setItem('maskPainterProgress', JSON.stringify(userProgress));
}

// === UI DINÁMICA ===
function renderMaskSelector() {
    const container = document.getElementById('maskListContainer');
    container.innerHTML = '';

    MASK_ORDER.forEach((modelName, index) => {
        const div = document.createElement('div');
        div.className = `mask-item ${modelName === currentModelName ? 'selected' : ''}`;
        
        const isLocked = (index + 1) > userProgress.unlockedMasks;
        if (isLocked) div.classList.add('locked');
        else div.classList.add('interactive-ui'); // Clase para sonido

        div.dataset.model = modelName;
        
        const imgIndex = index + 1;
        const img = document.createElement('img');
        img.src = `assets/masks/mask${imgIndex}_preview.jpg`;
        img.alt = `Máscara ${imgIndex}`;
        
        div.appendChild(img);
        
        div.addEventListener('click', (e) => {
            if (isLocked) return; 

            document.querySelectorAll('.mask-item').forEach(i => i.classList.remove('selected'));
            div.classList.add('selected');

            if (currentModelName !== modelName) {
                loadMaskModel(modelName);
            }
        });

        container.appendChild(div);
    });
    
    // Re-aplicar sonidos a los nuevos elementos generados
    setupUISounds();
}

// === CREAR CANVAS DE PINTURA ===
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

// === GESTIÓN DE ESTADOS DE MÁSCARAS ===
function saveCurrentMaskState() {
    const currentPixels = paintContext.getImageData(0, 0, paintCanvas.width, paintCanvas.height);
    
    maskStates[currentModelName] = {
        imageData: currentPixels,
        history: [...paintHistory],
        redoStack: [...paintRedoStack]
    };
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

    if (paintTexture) {
        paintTexture.needsUpdate = true;
    }
    updateHistoryButtons();
}

// === CARGAR MODELO OBJ ===
function loadMaskModel(modelName) {
    saveCurrentMaskState();

    if (mask) {
        scene.remove(mask);
        mask.traverse((child) => {
            if (child.isMesh) {
                child.geometry.dispose();
                if (child.material.map && child.material.map !== paintTexture) {
                    child.material.map.dispose();
                }
            }
        });
        mask = null;
    }

    restoreMaskState(modelName);

    textureLoader = new THREE.TextureLoader();
    const material = new THREE.MeshStandardMaterial({
        map: paintTexture,
        aoMapIntensity: 1.0,
        metalness: 0.1,
        roughness: 0.5,
        side: THREE.DoubleSide
    });

    const loadOptionalTexture = (type, path) => {
        textureLoader.load(path, 
            (tex) => { material[type] = tex; material.needsUpdate = true; },
            undefined, () => {}
        );
    };

    loadOptionalTexture('normalMap', `assets/models/${modelName}_normal.png`);
    loadOptionalTexture('aoMap', `assets/models/${modelName}_ao.png`);
    loadOptionalTexture('roughnessMap', `assets/models/${modelName}_roughness.png`);

    const loader = new THREE.OBJLoader();
    loader.load(`assets/models/${modelName}.obj`, function (object) {
        const maskGroup = new THREE.Group();
        
        object.traverse(function (child) {
            if (child instanceof THREE.Mesh) child.material = material;
        });

        const box = new THREE.Box3().setFromObject(object);
        const center = box.getCenter(new THREE.Vector3());
        object.position.sub(center);

        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const scaleFactor = 3 / maxDim;
        object.scale.multiplyScalar(scaleFactor);

        maskGroup.add(object);
        mask = maskGroup;
        scene.add(maskGroup);
        
        // --- ANIMACIÓN Y SONIDO DE ENTRADA ---
        isEntryAnimation = true;
        animationProgress = 0;
        mask.scale.set(0, 0, 0); 
        
        // Reproducir sonido mágico
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
    isEntryAnimation = true;
    animationProgress = 0;
    mask.scale.set(0, 0, 0);
    playSound('appear');
}

// === ANIMACIÓN ===
function animate() {
    requestAnimationFrame(animate);
    
    if (mask) {
        if (isEntryAnimation) {
            animationProgress += ANIMATION_SPEED;
            if (animationProgress >= 1) {
                animationProgress = 1;
                isEntryAnimation = false;
                mask.scale.set(1, 1, 1);
                mask.rotation.set(0, 0, 0); 
                mask.position.set(0, 0, 0);
            } else {
                const scale = animationProgress; 
                mask.scale.set(scale, scale, scale);
                mask.rotation.y = animationProgress * Math.PI * 4;
            }
        }
    }

    renderer.render(scene, camera);
}

// === INTERACCIÓN Y EVENTOS ===
function setupEventListeners() {
    const canvas = document.getElementById('gameCanvas');
    
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseUp);
    
    canvas.addEventListener('touchstart', onTouchStart);
    canvas.addEventListener('touchmove', onTouchMove);
    canvas.addEventListener('touchend', onTouchEnd);
    canvas.addEventListener('wheel', onMouseWheel, { passive: false });
    window.addEventListener('resize', onWindowResize);
    document.addEventListener('keydown', onKeyDown);

    setupUIControls();
    setupColorMixing();
    setupSaveAndGallerySystem();
    setupUISounds(); // Inicializar listeners de sonido
}

function setupUIControls() {
    const paletteToggle = document.getElementById('paletteToggle');
    paletteToggle.addEventListener('click', () => {
        document.getElementById('colorPalette').classList.toggle('open');
        paletteToggle.classList.toggle('open');
        document.getElementById('maskSelector').classList.remove('open');
        document.getElementById('maskToggle').classList.remove('open');
    });

    const maskToggle = document.getElementById('maskToggle');
    maskToggle.addEventListener('click', () => {
        document.getElementById('maskSelector').classList.toggle('open');
        maskToggle.classList.toggle('open');
        document.getElementById('colorPalette').classList.remove('open');
        document.getElementById('paletteToggle').classList.remove('open');
    });

    const lightToggle = document.getElementById('lightToggle');
    let isLightRight = true;
    lightToggle.addEventListener('click', () => {
        isLightRight = !isLightRight;
        const x = Math.abs(mainLight.position.x);
        mainLight.position.x = isLightRight ? x : -x;
        lightToggle.style.transform = isLightRight ? 'rotate(0deg)' : 'rotate(-15deg)';
    });

    const musicToggle = document.getElementById('musicToggle');
    musicToggle.addEventListener('click', () => {
        if (backgroundMusic.paused) {
            backgroundMusic.play();
            musicToggle.textContent = '🔊';
        } else {
            backgroundMusic.pause();
            musicToggle.textContent = '🔇';
        }
    });

    document.getElementById('brushSizeSlider').addEventListener('input', (e) => {
        brushSize = parseInt(e.target.value);
        document.getElementById('brushSizeValue').textContent = brushSize;
    });

    document.getElementById('undoButton').addEventListener('click', () => undo());
    document.getElementById('redoButton').addEventListener('click', () => redo());

    document.getElementById('clearButton').addEventListener('click', () => {
        playSound('click'); // Sonido extra de confirmación
        if (confirm('¿Estás seguro de querer borrar todo el diseño actual? No se podrá deshacer.')) {
            paintContext.fillStyle = BASE_MASK_COLOR;
            paintContext.fillRect(0, 0, paintCanvas.width, paintCanvas.height);
            paintTexture.needsUpdate = true;
            paintHistory = []; 
            paintRedoStack = [];
            saveCanvasState(); 
        }
    });
}

// === SISTEMA DE AUDIO ===
function setupAudio() {
    // Música de fondo
    backgroundMusic = new Audio('assets/audio/background.mp3');
    backgroundMusic.loop = true;
    backgroundMusic.volume = 0.3;
    
    // SFX - Asegúrate de tener estos archivos o cambiar los nombres
    sfx.click = new Audio('assets/audio/click.ogg');
    sfx.hover = new Audio('assets/audio/hover.ogg');
    sfx.appear = new Audio('assets/audio/appear.ogg'); // Sonido mágico

    // Ajustar volúmenes
    if(sfx.click) sfx.click.volume = 0.6;
    if(sfx.hover) sfx.hover.volume = 0.2; // Muy suave
    if(sfx.appear) sfx.appear.volume = 0.5;

    // Desbloquear audio en primera interacción
    document.addEventListener('click', function playMusic() {
        backgroundMusic.play().catch(e => console.log('Esperando interacción para audio'));
        document.removeEventListener('click', playMusic);
    }, { once: true });
}

// Función helper para reproducir sonidos sin cortarse
function playSound(type) {
    if (sfx[type]) {
        // Clonar el nodo permite reproducir el mismo sonido varias veces simultáneamente
        const soundClone = sfx[type].cloneNode(); 
        soundClone.volume = sfx[type].volume;
        soundClone.play().catch(() => {});
    }
}

function setupUISounds() {
    // Seleccionar elementos interactivos
    // Usamos selectores múltiples para atrapar todos los botones y tarjetas
    const interactiveElements = document.querySelectorAll(
        '#ui div, button, .mask-item:not(.locked), .gallery-item, #topRightActions div, #musicToggle, #lightToggle, #undoButton, #redoButton, #clearButton'
    );

    interactiveElements.forEach(el => {
        // Evitar duplicar listeners
        if (el.dataset.soundAttached) return; 
        
        el.addEventListener('mouseenter', () => playSound('hover'));
        el.addEventListener('click', () => playSound('click'));
        
        el.dataset.soundAttached = "true";
    });
}

// === SISTEMA DE GUARDADO Y GALERÍA ===
function setupSaveAndGallerySystem() {
    const saveBtn = document.getElementById('saveButton');
    const saveModal = document.getElementById('saveModal');
    const cancelSave = document.getElementById('cancelSave');
    const confirmSave = document.getElementById('confirmSave');
    
    const galleryBtn = document.getElementById('galleryButton');
    const galleryModal = document.getElementById('galleryModal');
    const closeGallery = document.getElementById('closeGallery');

    saveBtn.addEventListener('click', () => {
        saveModal.classList.add('open');
        document.getElementById('designName').value = '';
        document.getElementById('designDesc').value = '';
    });

    cancelSave.addEventListener('click', () => saveModal.classList.remove('open'));

    confirmSave.addEventListener('click', () => {
        const name = document.getElementById('designName').value || 'Sin nombre';
        const desc = document.getElementById('designDesc').value || '';
        
        saveDesignToGallery(name, desc);
        saveModal.classList.remove('open');
    });

    galleryBtn.addEventListener('click', () => {
        updateGalleryUI();
        galleryModal.classList.add('open');
    });

    closeGallery.addEventListener('click', () => galleryModal.classList.remove('open'));
}

function saveDesignToGallery(name, desc) {
    renderer.render(scene, camera);
    const imageDataURL = renderer.domElement.toDataURL('image/png');
    
    const newItem = {
        id: Date.now(),
        maskModel: currentModelName,
        name: name,
        description: desc,
        image: imageDataURL,
        date: new Date().toLocaleDateString()
    };
    
    userProgress.gallery.unshift(newItem); 

    const currentIndex = MASK_ORDER.indexOf(currentModelName);
    
    if (currentIndex + 1 === userProgress.unlockedMasks) {
        if (userProgress.unlockedMasks < MASK_ORDER.length) {
            userProgress.unlockedMasks++;
            renderMaskSelector();
        }
    }
    
    saveProgress();
    showToast("¡Diseño guardado exitosamente!");
}

function showToast(message) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.className = "show";
    setTimeout(function(){ toast.className = toast.className.replace("show", ""); }, 3000);
}

function updateGalleryUI() {
    const grid = document.getElementById('galleryGrid');
    grid.innerHTML = '';
    
    if (userProgress.gallery.length === 0) {
        grid.innerHTML = '<p id="emptyGalleryMsg">Aún no hay diseños. ¡Guarda uno!</p>';
        return;
    }

    userProgress.gallery.forEach(item => {
        const div = document.createElement('div');
        div.className = 'gallery-item';
        
        const deleteBtn = document.createElement('div');
        deleteBtn.className = 'delete-card-btn';
        deleteBtn.textContent = '×';
        deleteBtn.title = 'Eliminar diseño';
        deleteBtn.onclick = (e) => {
            e.stopPropagation(); 
            playSound('click');
            deleteGalleryItem(item.id);
        };

        div.appendChild(deleteBtn);

        const content = `
            <div class="gallery-img-container">
                <img src="${item.image}" alt="${item.name}">
            </div>
            <h4>${item.name}</h4>
            <small>${item.maskModel} - ${item.date}</small>
        `;
        div.insertAdjacentHTML('beforeend', content);

        const shareBtn = document.createElement('button');
        shareBtn.className = 'share-insta-btn';
        shareBtn.textContent = '📸 Postear / Descargar';
        shareBtn.onclick = () => {
            playSound('click');
            handleInstagramShare(item.image, item.name);
        };
        div.appendChild(shareBtn);

        grid.appendChild(div);
    });
    
    // Importante: Asignar sonidos a los nuevos elementos de la galería
    setupUISounds();
}

async function handleInstagramShare(base64Image, title) {
    const file = await dataURLtoFile(base64Image, 'mi_mascara.png');

    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({
                files: [file],
                title: 'Mi Diseño de Máscara',
                text: `¡Mira mi diseño "${title}"! #MaskPainter`,
            });
        } catch (error) {
            console.log('Error al compartir', error);
        }
    } else {
        const link = document.createElement('a');
        link.href = base64Image;
        link.download = `mask_${title.replace(/\s+/g, '_')}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        showToast("Imagen descargada. Abriendo Instagram...");
        setTimeout(() => {
            window.open('https://instagram.com', '_blank');
        }, 1500);
    }
}

async function dataURLtoFile(dataurl, filename) {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while(n--){
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, {type:mime});
}

function deleteGalleryItem(id) {
    if (confirm('¿Eliminar este diseño de la galería permanentemente?')) {
        userProgress.gallery = userProgress.gallery.filter(item => item.id !== id);
        saveProgress();
        updateGalleryUI();
    }
}

// === UTILS ===
function setupColorMixing() {
    const colorPicker = document.getElementById('colorPicker');
    selectedColor = colorPicker.value;
    colorPicker.addEventListener('input', (e) => selectedColor = e.target.value);
}

// === INPUT HANDLERS (MOUSE & TOUCH) ===
function onMouseDown(e) {
    if (isEntryAnimation) return;
    const canvas = document.getElementById('gameCanvas');

    if (e.button === 0) {
        isMouseDown = true;
        previousMousePosition = { x: e.clientX, y: e.clientY };
        
        if (isPaintMode) {
            paintAtPosition(e.clientX, e.clientY);
        }
    } 
    else if (e.button === 2) {
        isRightMouseDown = true;
        previousMousePosition = { x: e.clientX, y: e.clientY };
        
        if (!isPaintMode) {
            canvas.style.cursor = 'grabbing';
        }
    }
}

function onMouseMove(e) {
    if (isEntryAnimation) return;

    if (isPaintMode && isMouseDown) {
        paintAtPosition(e.clientX, e.clientY);
    } 
    else if (!isPaintMode) {
        const deltaX = e.clientX - previousMousePosition.x;
        const deltaY = e.clientY - previousMousePosition.y;

        if (isMouseDown) {
            mask.rotation.y += deltaX * 0.01;
            mask.rotation.x += deltaY * 0.01;
        } 
        else if (isRightMouseDown) {
            mask.position.x += deltaX * 0.01;
            mask.position.y -= deltaY * 0.01;
            mask.position.x = Math.max(-3, Math.min(3, mask.position.x));
            mask.position.y = Math.max(-2, Math.min(2, mask.position.y));
        }

        previousMousePosition = { x: e.clientX, y: e.clientY };
    }
}

function onMouseUp() {
    isMouseDown = false;
    isRightMouseDown = false;
    lastPaintPosition = null;
    
    const canvas = document.getElementById('gameCanvas');
    if (isPaintMode) {
        canvas.style.cursor = 'crosshair';
        if (!isEntryAnimation) saveCanvasState();
    } else {
        canvas.style.cursor = 'move';
    }
}

function onTouchStart(e) {
    if (isEntryAnimation) return;
    e.preventDefault();
    const touch = e.touches[0];
    isMouseDown = true; 
    previousMousePosition = { x: touch.clientX, y: touch.clientY };
    if (isPaintMode) paintAtPosition(touch.clientX, touch.clientY);
}

function onTouchMove(e) {
    if (!isMouseDown || isEntryAnimation) return;
    e.preventDefault();
    const touch = e.touches[0];
    if (isPaintMode) {
        paintAtPosition(touch.clientX, touch.clientY);
    } else {
        const deltaX = touch.clientX - previousMousePosition.x;
        const deltaY = touch.clientY - previousMousePosition.y;
        mask.rotation.y += deltaX * 0.01;
        mask.rotation.x += deltaY * 0.01;
        previousMousePosition = { x: touch.clientX, y: touch.clientY };
    }
}

function onTouchEnd() {
    isMouseDown = false;
    lastPaintPosition = null;
    if (isPaintMode && !isEntryAnimation) saveCanvasState();
}

function paintAtPosition(x, y) {
    const mouse = new THREE.Vector2(
        (x / window.innerWidth) * 2 - 1,
        -(y / window.innerHeight) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(mask.children, true);

    if (intersects.length > 0) {
        const uv = intersects[0].uv;
        if (uv) {
            const canvasX = uv.x * paintCanvas.width;
            const canvasY = (1 - uv.y) * paintCanvas.height;
            if (lastPaintPosition) {
                interpolatePaint(lastPaintPosition.x, lastPaintPosition.y, canvasX, canvasY);
            } else {
                drawBrush(canvasX, canvasY);
            }
            lastPaintPosition = { x: canvasX, y: canvasY };
            paintTexture.needsUpdate = true;
        }
    }
}

function drawBrush(x, y) {
    paintContext.globalCompositeOperation = 'source-over';
    const gradient = paintContext.createRadialGradient(x, y, 0, x, y, brushSize);
    gradient.addColorStop(0, selectedColor);
    gradient.addColorStop(0.5, selectedColor + 'DD');
    gradient.addColorStop(1, selectedColor + '00');
    paintContext.fillStyle = gradient;
    paintContext.beginPath();
    paintContext.arc(x, y, brushSize, 0, Math.PI * 2);
    paintContext.fill();
}

function interpolatePaint(x1, y1, x2, y2) {
    const distance = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    const steps = Math.max(1, Math.ceil(distance / (brushSize * 0.25)));
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        drawBrush(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
    }
}

// === HISTORIAL: GUARDAR, DESHACER Y REHACER ===

function saveCanvasState() {
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

function updateHistoryButtons() {
    const undoBtn = document.getElementById('undoButton');
    const redoBtn = document.getElementById('redoButton');

    undoBtn.classList.toggle('disabled', paintHistory.length <= 1);
    redoBtn.classList.toggle('disabled', paintRedoStack.length === 0);
}

// === KEYBOARD SHORTCUTS ===
function onKeyDown(e) {
    const tag = e.target.tagName.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.code === 'Space') {
        e.preventDefault();
        isPaintMode = !isPaintMode;
        document.getElementById('paintMode').textContent = `Modo: ${isPaintMode ? 'Pintar 🎨' : 'Mover 🔄'}`;
        document.getElementById('gameCanvas').style.cursor = isPaintMode ? 'crosshair' : 'move';
        
        // Efecto de sonido al cambiar de modo
        playSound('hover'); 

        changeBackground();
    }
    
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
    }
    
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        redo();
    }
}

function changeBackground() {
    const bg1 = document.getElementById('backgroundImage1');
    const bg2 = document.getElementById('backgroundImage2');
    if (bg1.classList.contains('active')) {
        bg1.classList.remove('active');
        bg2.classList.add('active');
    } else {
        bg2.classList.remove('active');
        bg1.classList.add('active');
    }
}

function onMouseWheel(e) {
    e.preventDefault();
    if (e.deltaY < 0) {
        camera.position.z = Math.max(0.5, camera.position.z - 0.3);
    } else {
        camera.position.z = Math.min(10, camera.position.z + 0.1);
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

init();