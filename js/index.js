console.log('Script loaded successfully');

// Splash Screen Logic
document.addEventListener('deviceready', onDeviceReady, false);

function onDeviceReady() {
    console.log('Device is ready');

    // Hide the native Cordova splash screen (grey icon) immediately
    if (navigator.splashscreen) {
        navigator.splashscreen.hide();
    }

    const splash = document.getElementById('splashScreen');
    if (splash) {
        // Show our custom splash for at least 3 seconds for that "firing up" feel
        setTimeout(() => {
            splash.classList.add('fade-out');
            setTimeout(() => {
                splash.style.display = 'none';
            }, 800); // Wait for CSS transition
        }, 3000);
    }
}

// Fallback for browser testing
if (!window.cordova) {
    window.addEventListener('load', () => {
        setTimeout(onDeviceReady, 500);
    });
}
let currentImage = null;
const MAX_BASE64_LENGTH = 100000;
const SMART_TARGET_LENGTH = 5000;
const INITIAL_MAX_EDGE = 1024;
const MIN_EDGE = 512;
let convertMode = 'smart';
let smartPreset = 5000;
let manualResize = 0.1;
let isLivePreview = true;
let cachedImage = null; // Store the re-usable Image object
let estimationTimeout = null;
let lastEstimatedLength = 0;
let isEstimating = false;
let needsReEstimate = false;

// Audio recording state
let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;
let isRecording = false;
let recordingStartTime = 0;
let recordingInterval = null;
let recordingDuration = 0;
let is100kEnabled = false;
let isLocked = false;

async function pasteText(targetId) {
    const textarea = document.getElementById(targetId);
    if (!textarea) return;

    // Always focus first
    textarea.focus();

    // Tiny delay to ensure focus is active before plugin call
    await new Promise(r => setTimeout(r, 100));

    try {
        // 1. Try Cordova Clipboard Plugin (Recommended for Cordova)
        if (window.cordova && cordova.plugins && cordova.plugins.clipboard) {
            console.log('Using Cordova Clipboard Plugin');
            cordova.plugins.clipboard.paste((text) => {
                if (text) {
                    textarea.value = text;
                    showToast('Pasted from clipboard!');
                    // Trigger input event to update any listeners
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                } else {
                    showToast('Clipboard is empty.');
                }
            }, (err) => {
                console.warn('Plugin Paste Error:', err);
                // Fallback to navigator
                tryNavigatorPaste(textarea);
            });
            return;
        }

        // 2. Fallback to navigator.clipboard
        console.log('Using Navigator Clipboard API');
        await tryNavigatorPaste(textarea);
    } catch (err) {
        console.error('All paste methods failed:', err);
        // Final fallback: show error with instruction
        showToast('System blocked paste. Please paste manually.', true);
    }
}

async function tryNavigatorPaste(textarea) {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
        throw new Error('Navigator Clipboard API not supported');
    }

    try {
        const text = await navigator.clipboard.readText();
        textarea.value = text;
        showToast('Pasted from clipboard!');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (err) {
        console.warn('Navigator paste failed:', err);
        // If it's a permission error, inform the user
        if (err.name === 'NotAllowedError') {
            showToast('Permission denied. Please paste manually.', true);
        } else {
            throw err;
        }
    }
}

function showSection(section) {
    const sections = {
        'imgToText': document.getElementById('imgToTextSection'),
        'textToImg': document.getElementById('textToImgSection'),
        'textToAudio': document.getElementById('textToAudioSection'),
        'audioToText': document.getElementById('audioToTextSection')
    };
    const tabs = {
        'imgToText': document.getElementById('imgToTextTab'),
        'textToImg': document.getElementById('textToImgTab'),
        'textToAudio': document.getElementById('textToAudioTab'),
        'audioToText': document.getElementById('audioToTextTab')
    };

    for (const key in sections) {
        if (key === section) {
            sections[key].style.display = 'block';
            tabs[key].classList.add('active');
        } else {
            sections[key].style.display = 'none';
            tabs[key].classList.remove('active');
        }
    }
}

function setConvertMode(mode) {
    convertMode = mode;
    const smartBtn = document.getElementById('smartModeBtn');
    const manualBtn = document.getElementById('manualModeBtn');
    const manualControls = document.getElementById('manualControls');
    const smartBadge = document.getElementById('smartBadge');
    const smartPresets = document.getElementById('smartPresets');

    if (mode === 'smart') {
        smartBtn.classList.add('active');
        manualBtn.classList.remove('active');
        manualControls.style.display = 'none';
        smartBadge.style.display = 'flex';
        smartPresets.style.display = 'flex';
    } else {
        smartBtn.classList.remove('active');
        manualBtn.classList.add('active');
        manualControls.style.display = 'block';
        smartBadge.style.display = 'none';
        smartPresets.style.display = 'none';
    }
    if (currentImage) updateEstimation();
}

function setSmartTargetLimit(limit) {
    smartPreset = limit;
    // Update UI active state for targets
    document.querySelectorAll('#smartPresets button').forEach(btn => btn.classList.remove('active'));
    const btn = document.getElementById(`target${limit}`);
    if (btn) btn.classList.add('active');

    updateSmartBadge();

    // Update target limit label
    const targetLabel = document.getElementById('targetLimitLabel');
    if (targetLabel) targetLabel.textContent = limit.toLocaleString();

    if (currentImage) updateEstimation();
}

function updateSmartBadge() {
    document.getElementById('smartStatus').textContent = `Smart targeting ~${smartPreset.toLocaleString()} characters`;
}

function getSmartTarget(limit) {
    return limit;
}

function getSmartConfig(limit) {
    if (limit <= 5000) return { maxEdge: 480, qualityStart: 0.7, qualityFloor: 0.05, resizeStep: 0.8, minEdge: 64 };
    if (limit <= 10000) return { maxEdge: 720, qualityStart: 0.8, qualityFloor: 0.1, resizeStep: 0.85, minEdge: 128 };
    if (limit <= 15000) return { maxEdge: 960, qualityStart: 0.85, qualityFloor: 0.2, resizeStep: 0.9, minEdge: 256 };
    return { maxEdge: 1280, qualityStart: 0.9, qualityFloor: 0.3, resizeStep: 0.92, minEdge: 480 };
}

// Image Quality Slider
const qualitySlider = document.getElementById('qualitySlider');
const qualityValue = document.getElementById('qualityValue');
const resizeSlider = document.getElementById('resizeSlider');
const resizeValue = document.getElementById('resizeValue');
const charCount = document.getElementById('charCount');
const estimateWrapper = document.getElementById('estimateWrapper');

qualitySlider.addEventListener('input', (e) => handleSliderInput(e, 'quality'));
qualitySlider.addEventListener('change', (e) => handleSliderChange(e, 'quality'));

resizeSlider.addEventListener('input', (e) => handleSliderInput(e, 'resize'));
resizeSlider.addEventListener('change', (e) => handleSliderChange(e, 'resize'));

function handleSliderInput(e, type) {
    const value = e.target.value;
    if (type === 'quality') {
        qualityValue.textContent = value + '%';
        if (isLocked) {
            resizeSlider.value = value;
            resizeValue.textContent = value + '%';
            manualResize = value / 100;
        }
    } else {
        resizeValue.textContent = value + '%';
        manualResize = value / 100;
        if (isLocked) {
            qualitySlider.value = value;
            qualityValue.textContent = value + '%';
        }
    }

    if (isLivePreview && currentImage) {
        updateEstimation(true);
    }
}

function handleSliderChange(e, type) {
    if (!isLivePreview && currentImage) {
        updateEstimation(true);
    }
}

function toggleLivePreview() {
    isLivePreview = !isLivePreview;
    const btn = document.getElementById('livePreviewBtn');
    const icon = document.getElementById('liveIcon');
    const text = document.getElementById('liveText');

    if (isLivePreview) {
        btn.classList.add('active');
        icon.className = 'fas fa-eye';
        text.textContent = 'Live Preview';
        if (currentImage) updateEstimation(true);
    } else {
        btn.classList.remove('active');
        icon.className = 'fas fa-eye-slash';
        text.textContent = 'Preview Off';
    }
}

function toggleLockBoth() {
    isLocked = !isLocked;
    const btn = document.getElementById('lockBothBtn');
    const icon = document.getElementById('lockIcon');
    const text = document.getElementById('lockText');

    if (isLocked) {
        btn.classList.add('active');
        icon.className = 'fas fa-lock';
        text.textContent = 'Locked both';

        // Snap both to 10 when first enabled
        qualitySlider.value = 10;
        qualityValue.textContent = '10%';
        resizeSlider.value = 10;
        resizeValue.textContent = '10%';
        manualResize = 0.1;

        if (currentImage) updateEstimation(true);
    } else {
        btn.classList.remove('active');
        icon.className = 'fas fa-lock-open';
        text.textContent = 'Lock Both';
    }
}

function getPerceptualQuality(sliderValue) {
    return Math.pow(sliderValue / 100, 2.2);
}

async function smartCompress(img, targetLimit, initialQuality, initialMaxEdge, isSmart, smartConfig) {
    let quality = isSmart ? smartConfig.qualityStart : initialQuality;
    let maxEdge = isSmart ? smartConfig.maxEdge : initialMaxEdge;
    let finalDataUrl = "";
    let attempts = 0;
    const maxAttempts = isSmart ? 60 : 1;

    while (attempts < maxAttempts) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        let width = img.width, height = img.height;

        if (width > height) {
            if (width > maxEdge) { height *= maxEdge / width; width = maxEdge; }
        } else {
            if (height > maxEdge) { width *= maxEdge / height; height = maxEdge; }
        }

        canvas.width = Math.max(1, width);
        canvas.height = Math.max(1, height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        finalDataUrl = canvas.toDataURL('image/webp', quality);

        if (finalDataUrl.length <= targetLimit || !isSmart) break;

        if (quality > smartConfig.qualityFloor) {
            quality -= 0.05;
        } else if (maxEdge > smartConfig.minEdge) {
            maxEdge *= smartConfig.resizeStep;
            quality = Math.min(0.9, smartConfig.qualityFloor + 0.2);
        } else if (maxEdge > 64) {
            maxEdge *= 0.8;
            quality *= 0.8;
        } else {
            break;
        }

        if (attempts % 3 === 0) await new Promise(r => requestAnimationFrame(r));
        attempts++;
    }
    return finalDataUrl;
}

function updateEstimation(immediate = false) {
    if (estimationTimeout) clearTimeout(estimationTimeout);

    const run = async () => {
        if (!cachedImage || isEstimating) {
            if (isEstimating) needsReEstimate = true;
            return;
        }

        const loader = document.getElementById('previewLoader');
        const previewContainer = document.getElementById('livePreviewContainer');

        // Show container immediately
        previewContainer.style.display = 'block';

        // Only show loader in Smart Mode (Manual mode is usually near-instant)
        const isSmartMode = convertMode === 'smart';
        if (isSmartMode) {
            loader.style.display = 'flex';
            // Yield to event loop to ensure loader paints
            await new Promise(resolve => setTimeout(resolve, 30));
        } else {
            loader.style.display = 'none';
        }

        isEstimating = true;

        try {
            do {
                needsReEstimate = false;

                const isSmart = convertMode === 'smart';
                const currentGlobalLimit = is100kEnabled ? 100000 : 90000;
                const targetLimit = isSmart ? getSmartTarget(smartPreset) : currentGlobalLimit;
                const sliderValue = isSmart ? smartPreset : parseInt(qualitySlider.value);
                const quality = getPerceptualQuality(sliderValue);
                const maxEdge = isSmart ? (getSmartConfig(smartPreset).maxEdge) : (Math.max(cachedImage.width, cachedImage.height) * manualResize);
                const smartConfig = isSmart ? getSmartConfig(smartPreset) : null;

                let dataUrl = await smartCompress(cachedImage, targetLimit, quality, maxEdge, isSmart, smartConfig);

                if (((isSmart && smartPreset === 99) || (!isSmart && sliderValue === 100)) && currentImage.length <= targetLimit && currentImage.length < dataUrl.length) {
                    dataUrl = currentImage;
                }

                const length = dataUrl.length;

                // Skip animation for live manual sliding to ensure instant feedback
                if (immediate && !needsReEstimate) {
                    charCount.textContent = length.toLocaleString();
                    lastEstimatedLength = length;
                } else if (!needsReEstimate) {
                    // Animate for smart presets where changes are discrete
                    animateNumber(charCount, lastEstimatedLength, length, 500);
                    lastEstimatedLength = length;
                }

                // Update Live Preview
                if (!needsReEstimate) {
                    const previewImg = document.getElementById('liveResultPreview');
                    previewImg.src = dataUrl;
                    previewContainer.style.display = 'block';

                    // Show/hide character count warning
                    const warningElement = document.getElementById('charCountWarning');
                    if (length > (isSmart ? targetLimit : 20000)) {
                        warningElement.style.display = 'block';
                    } else {
                        warningElement.style.display = 'none';
                    }

                    const convertBtn = document.querySelector('#imgToTextSection .primary-btn');
                    if (length > currentGlobalLimit && !isSmart) {
                        estimateWrapper.style.color = '#ff4d4d';
                        if (convertBtn) convertBtn.disabled = true;
                    } else if (length > (isSmart ? targetLimit * 0.8 : 20000)) {
                        estimateWrapper.style.color = '#ffa500';
                        if (convertBtn) convertBtn.disabled = false;
                    } else {
                        estimateWrapper.style.color = '#8e96b3';
                        if (convertBtn) convertBtn.disabled = false;
                    }
                }
            } while (needsReEstimate);
        } finally {
            isEstimating = false;
            loader.style.display = 'none';
        }
    };

    if (immediate) {
        run();
    } else {
        // Debounce for smart presets
        estimationTimeout = setTimeout(run, 150);
    }
}

document.getElementById('imageInput').addEventListener('change', function (e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (event) {
        currentImage = event.target.result;

        // Cache the Image object once
        cachedImage = new Image();
        cachedImage.src = currentImage;
        cachedImage.onload = () => {
            document.getElementById('imagePreviewContainer').style.display = 'block';
            document.getElementById('selectedImagePreview').src = currentImage;
            document.getElementById('modeSelector').style.display = 'flex';
            document.getElementById('qualityControl').style.display = 'block';

            // Update Original Size
            const originalLength = currentImage.length;
            document.getElementById('originalCharCount').textContent = originalLength.toLocaleString();
            document.getElementById('originalSizeInfo').style.display = 'inline';

            setConvertMode(convertMode);
            updateEstimation();
        };
    };
    reader.readAsDataURL(file);
});

async function convertToBase64() {
    if (!currentImage || !cachedImage) {
        showToast('Please select an image first.');
        return;
    }

    const overlay = document.getElementById('loadingOverlay');
    const convertBtn = document.querySelector('#imgToTextSection .primary-btn');

    // Show loader and disable UI
    overlay.style.display = 'flex';
    if (convertBtn) convertBtn.disabled = true;

    // Small delay to allow UI to render the overlay before blocking processing
    await new Promise(resolve => setTimeout(resolve, 50));

    try {
        const isSmart = convertMode === 'smart';
        const currentGlobalLimit = is100kEnabled ? 100000 : 90000;
        const targetLimit = isSmart ? getSmartTarget(smartPreset) : currentGlobalLimit;
        const sliderValue = isSmart ? smartPreset : parseInt(qualitySlider.value);
        const quality = getPerceptualQuality(sliderValue);
        const maxEdge = isSmart ? (getSmartConfig(smartPreset).maxEdge) : (Math.max(cachedImage.width, cachedImage.height) * manualResize);
        const smartConfig = isSmart ? getSmartConfig(smartPreset) : null;

        let finalDataUrl = await smartCompress(cachedImage, targetLimit, quality, maxEdge, isSmart, smartConfig);

        if (((isSmart && smartPreset === 99) || (!isSmart && sliderValue === 100)) && currentImage.length <= targetLimit && currentImage.length < finalDataUrl.length) {
            finalDataUrl = currentImage;
        }

        if (finalDataUrl.length > targetLimit && !isSmart) {
            showToast('Character limit exceeded!', true);
            return;
        }

        const output = document.getElementById('base64Output');
        output.value = finalDataUrl;

        document.getElementById('finalCharCount').textContent = finalDataUrl.length.toLocaleString();

        // Show/hide character count warning in final result
        const warningElement = document.getElementById('charCountWarning');
        if (finalDataUrl.length > currentGlobalLimit) {
            warningElement.style.display = 'block';
        } else {
            warningElement.style.display = 'none';
        }

        document.getElementById('resultContainer').style.display = 'block';
        document.getElementById('resultContainer').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
        console.error(err);
        showToast('Processing failed.', true);
    } finally {
        overlay.style.display = 'none';
        if (convertBtn) convertBtn.disabled = false;
    }
}

function copyText() {
    const textarea = document.getElementById('base64Output');
    textarea.select();
    try {
        navigator.clipboard.writeText(textarea.value);
        showToast('Copied to clipboard!');
    } catch (err) {
        showToast('Failed to copy.', true);
    }
}

function convertToImage() {
    const base64String = document.getElementById('base64Input').value.trim();
    const decodedImage = document.getElementById('decodedImage');
    const container = document.getElementById('decodedImageContainer');

    if (!base64String) {
        showToast('Paste a Base64 string first!', true);
        return;
    }

    let src = base64String;
    // Handle raw base64 (assume webp, match our output)
    if (!base64String.startsWith('data:')) {
        src = 'data:image/webp;base64,' + base64String;
    } else if (!base64String.startsWith('data:image/')) {
        showToast('This Base64 string looks like audio or other data, not an image.', true);
        return;
    }

    const tempImg = new Image();
    tempImg.src = src;
    tempImg.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = tempImg.width; canvas.height = tempImg.height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(tempImg, 0, 0);
        decodedImage.src = canvas.toDataURL('image/jpeg', 0.9);
        container.style.display = 'block';
        container.scrollIntoView({ behavior: 'smooth' });
    };
    tempImg.onerror = () => {
        showToast('Invalid image Base64 data.', true);
        container.style.display = 'none';
    };
}

function saveImage() {
    const src = document.getElementById('decodedImage').src;
    if (!src) return;

    const now = new Date();
    const hours = now.getHours();
    const ampm = hours >= 12 ? 'pm' : 'am';
    const h12 = hours % 12 || 12;
    const timestamp =
        String(h12).padStart(2, '0') + '-' +
        String(now.getMinutes()).padStart(2, '0') + '-' +
        String(now.getSeconds()).padStart(2, '0') + '-' +
        ampm + '-' +
        String(now.getDate()).padStart(2, '0') + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        now.getFullYear();
    const fileName = `saved-image-${timestamp}.jpg`;

    if (window.cordova) {
        const permissions = cordova.plugins.permissions;

        // Android 13+ Permissions: READ_MEDIA_IMAGES
        // Older Android Permissions: WRITE_EXTERNAL_STORAGE
        // We will request all relevant ones.
        const permissionsToRequest = [
            permissions.WRITE_EXTERNAL_STORAGE,
            permissions.READ_EXTERNAL_STORAGE
        ];

        // Add Android 13 permissions if they exist in the plugin constants
        if (permissions.READ_MEDIA_IMAGES) permissionsToRequest.push(permissions.READ_MEDIA_IMAGES);

        permissions.requestPermissions(permissionsToRequest, (status) => {
            if (status.hasPermission) {
                saveToDownloads(src, fileName);
            } else {
                // For Android 11+ WRITE_EXTERNAL_STORAGE might return false but we can still write to app-specific or sometimes Downloads
                // Let's try to write anyway or inform the user
                console.warn('Permission status not "hasPermission", trying anyway...');
                saveToDownloads(src, fileName);
            }
        }, () => showToast('Error requesting permissions.', true));
    } else {
        // Browser fallback
        const link = document.createElement('a');
        link.href = src;
        link.download = fileName;
        link.click();
    }
}

async function saveAudio(elementId = 'audioPreview', prefix = 'converted-audio') {
    const audioEl = document.getElementById(elementId);
    const src = audioEl ? audioEl.src : null;
    if (!src) {
        showToast('No audio to save.', true);
        return;
    }

    showToast('Converting to MP3... Please wait.');

    try {
        // 1. Fetch and Decode
        const response = await fetch(src);
        const arrayBuffer = await response.arrayBuffer();
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // Use Promise-based decodeAudioData
        const audioBuffer = await new Promise((resolve, reject) => {
            audioContext.decodeAudioData(arrayBuffer, resolve, reject);
        });

        // 2. Encode to MP3 using lamejs
        const mp3Blob = await encodeMp3(audioBuffer);

        // 3. Save
        const now = new Date();
        const hours = now.getHours();
        const ampm = hours >= 12 ? 'pm' : 'am';
        const h12 = hours % 12 || 12;
        const timestamp =
            String(h12).padStart(2, '0') + '-' +
            String(now.getMinutes()).padStart(2, '0') + '-' +
            String(now.getSeconds()).padStart(2, '0') + '-' +
            ampm + '-' +
            String(now.getDate()).padStart(2, '0') + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            now.getFullYear();

        const fileName = `${prefix}-${timestamp}.mp3`;

        if (window.cordova) {
            const permissions = cordova.plugins.permissions;
            const permissionsToRequest = [
                permissions.WRITE_EXTERNAL_STORAGE,
                permissions.READ_EXTERNAL_STORAGE
            ];

            if (permissions.READ_MEDIA_AUDIO) permissionsToRequest.push(permissions.READ_MEDIA_AUDIO);

            permissions.requestPermissions(permissionsToRequest, (status) => {
                if (status.hasPermission) {
                    saveBlobToDownloads(mp3Blob, fileName);
                } else {
                    saveBlobToDownloads(mp3Blob, fileName);
                }
            }, () => showToast('Error requesting permissions.', true));
        } else {
            // Browser fallback
            const url = URL.createObjectURL(mp3Blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 100);
        }
    } catch (err) {
        console.error('MP3 Conversion Error:', err);
        showToast('Failed to convert to MP3. Saving original...', true);
        // Fallback to original save if conversion fails
        saveOriginalAudio(src, prefix);
    }
}

async function encodeMp3(audioBuffer) {
    return new Promise((resolve) => {
        const channels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, 128);
        const mp3Data = [];
        const sampleBlockSize = 1152;

        if (channels === 2) {
            const left = audioBuffer.getChannelData(0);
            const right = audioBuffer.getChannelData(1);
            const leftInt = new Int16Array(left.length);
            const rightInt = new Int16Array(right.length);
            for (let i = 0; i < left.length; i++) {
                leftInt[i] = left[i] < 0 ? left[i] * 32768 : left[i] * 32767;
                rightInt[i] = right[i] < 0 ? right[i] * 32768 : right[i] * 32767;
            }

            for (let i = 0; i < leftInt.length; i += sampleBlockSize) {
                const leftChunk = leftInt.subarray(i, i + sampleBlockSize);
                const rightChunk = rightInt.subarray(i, i + sampleBlockSize);
                const mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
                if (mp3buf.length > 0) mp3Data.push(mp3buf);
            }
        } else {
            const mono = audioBuffer.getChannelData(0);
            const monoInt = new Int16Array(mono.length);
            for (let i = 0; i < mono.length; i++) {
                monoInt[i] = mono[i] < 0 ? mono[i] * 32768 : mono[i] * 32767;
            }

            for (let i = 0; i < monoInt.length; i += sampleBlockSize) {
                const chunk = monoInt.subarray(i, i + sampleBlockSize);
                const mp3buf = mp3encoder.encodeBuffer(chunk);
                if (mp3buf.length > 0) mp3Data.push(mp3buf);
            }
        }

        const mp3buf = mp3encoder.flush();
        if (mp3buf.length > 0) mp3Data.push(mp3buf);

        resolve(new Blob(mp3Data, { type: 'audio/mp3' }));
    });
}

function saveBlobToDownloads(blob, fileName) {
    const downloadPath = cordova.file.externalRootDirectory + "Download/";
    window.resolveLocalFileSystemURL(downloadPath, (dirEntry) => {
        dirEntry.getFile(fileName, { create: true, exclusive: false }, (fileEntry) => {
            fileEntry.createWriter((fileWriter) => {
                fileWriter.onwriteend = () => {
                    showToast('Saved to Downloads as MP3!');
                    if (window.cordova.plugins && window.cordova.plugins.MediaScanner) {
                        window.cordova.plugins.MediaScanner.scanFile(fileEntry.toURL());
                    }
                };
                fileWriter.onerror = (e) => {
                    console.error('File write error:', e);
                    showToast('Failed to save file.', true);
                };
                fileWriter.write(blob);
            });
        }, (err) => {
            console.error('File creation error:', err);
            showToast('Could not create file.', true);
        });
    }, (err) => {
        console.error('Download directory error:', err);
        showToast('Downloads folder not accessible.', true);
    });
}

function saveOriginalAudio(src, prefix) {
    const now = new Date();
    const hours = now.getHours();
    const ampm = hours >= 12 ? 'pm' : 'am';
    const h12 = hours % 12 || 12;
    const timestamp =
        String(h12).padStart(2, '0') + '-' +
        String(now.getMinutes()).padStart(2, '0') + '-' +
        String(now.getSeconds()).padStart(2, '0') + '-' +
        ampm + '-' +
        String(now.getDate()).padStart(2, '0') + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        now.getFullYear();

    let extension = 'webm';
    if (src.includes('audio/mp3') || src.includes('audio/mpeg')) extension = 'mp3';
    else if (src.includes('audio/wav')) extension = 'wav';

    const fileName = `${prefix}-${timestamp}.${extension}`;

    if (window.cordova) {
        saveToDownloads(src, fileName);
    } else {
        const link = document.createElement('a');
        link.href = src;
        link.download = fileName;
        link.click();
    }
}

function saveToDownloads(base64Data, fileName) {
    const blob = base64ToBlob(base64Data);
    const downloadPath = cordova.file.externalRootDirectory + "Download/";

    window.resolveLocalFileSystemURL(downloadPath, (dirEntry) => {
        dirEntry.getFile(fileName, { create: true, exclusive: false }, (fileEntry) => {
            fileEntry.createWriter((fileWriter) => {
                fileWriter.onwriteend = () => {
                    showToast('Saved to Downloads!');
                    // Refresh gallery (optional but helpful)
                    if (window.cordova.plugins && window.cordova.plugins.MediaScanner) {
                        window.cordova.plugins.MediaScanner.scanFile(fileEntry.toURL());
                    }
                };
                fileWriter.onerror = (e) => {
                    console.error('File write error:', e);
                    showToast('Failed to save file.', true);
                };
                fileWriter.write(blob);
            });
        }, (err) => {
            console.error('File creation error:', err);
            showToast('Could not create file.', true);
        });
    }, (err) => {
        console.error('Download directory error:', err);
        showToast('Downloads folder not accessible.', true);
    });
}

function base64ToBlob(base64) {
    const parts = base64.split(';base64,');
    const contentType = parts[0].split(':')[1];
    const raw = window.atob(parts[1]);
    const rawLength = raw.length;
    const uInt8Array = new Uint8Array(rawLength);
    for (let i = 0; i < rawLength; ++i) {
        uInt8Array[i] = raw.charCodeAt(i);
    }
    return new Blob([uInt8Array], { type: contentType });
}



function resetImgToText() {
    currentImage = null;
    cachedImage = null;
    document.getElementById('imageInput').value = '';
    document.getElementById('imagePreviewContainer').style.display = 'none';
    document.getElementById('selectedImagePreview').src = '';
    document.getElementById('modeSelector').style.display = 'none';
    document.getElementById('qualityControl').style.display = 'none';
    document.getElementById('livePreviewContainer').style.display = 'none';
    document.getElementById('liveResultPreview').src = '';
    document.getElementById('originalSizeInfo').style.display = 'none';
    document.getElementById('resultContainer').style.display = 'none';
    document.getElementById('base64Output').value = '';
}

function resetTextToImg() {
    document.getElementById('base64Input').value = '';
    document.getElementById('decodedImageContainer').style.display = 'none';
    document.getElementById('decodedImage').src = '';
}

function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    toast.textContent = message;

    if (isError) {
        toast.style.borderLeft = "4px solid #ff4d4d";
    } else {
        toast.style.borderLeft = "1px solid rgba(123, 97, 255, 0.3)";
    }

    toast.style.display = 'block';
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            toast.style.display = 'none';
        }, 300);
    }, 3000);
}

function animateNumber(element, start, end, duration) {
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        const current = Math.floor(progress * (end - start) + start);
        element.textContent = current.toLocaleString();
        if (progress < 1) {
            window.requestAnimationFrame(step);
        }
    };
    window.requestAnimationFrame(step);
}

// Audio Quality Slider
const audioQualitySlider = document.getElementById('audioQualitySlider');
const audioQualityValue = document.getElementById('audioQualityValue');

audioQualitySlider.addEventListener('input', (e) => {
    const val = e.target.value;
    audioQualityValue.textContent = val + ' kbps';
});

function convertBase64ToAudio() {
    const input = document.getElementById('audioBase64Input');
    const raw = input.value.trim();
    const preview = document.getElementById('audioPreview');
    const container = document.getElementById('audioPreviewContainer');

    if (!raw) {
        showToast('Paste Base64 audio string first!', true);
        return;
    }

    let src = raw;
    if (!raw.startsWith('data:')) {
        src = 'data:audio/webm;base64,' + raw;
    } else if (!raw.startsWith('data:audio/')) {
        showToast('This Base64 string looks like an image, not audio sound.', true);
        return;
    }

    preview.src = src;
    container.style.display = 'block';
    preview.play().catch(() => { /* User interaction required or invalid audio */ });
}

function resetTextToAudio() {
    document.getElementById('audioBase64Input').value = '';
    const preview = document.getElementById('audioPreview');
    const container = document.getElementById('audioPreviewContainer');
    preview.pause();
    preview.removeAttribute('src');
    container.style.display = 'none';
}

async function toggleRecording() {
    const recordBtn = document.getElementById('recordBtn');
    const recordLabel = document.getElementById('recordBtnLabel');
    const statusEl = document.getElementById('recordStatus');
    const statsEl = document.getElementById('recordingStats');
    const timeEl = document.getElementById('recordingTime');
    const charEl = document.getElementById('estimatedRecordingChars');

    if (isRecording) {
        stopRecording();
        return;
    }

    // Permission check for Cordova
    if (window.cordova && window.cordova.plugins && window.cordova.plugins.permissions) {
        const permissions = window.cordova.plugins.permissions;
        const micPermission = permissions.RECORD_AUDIO;

        permissions.checkPermission(micPermission, (status) => {
            if (status.hasPermission) {
                startRecordingProcess();
            } else {
                permissions.requestPermission(micPermission, (status) => {
                    if (status.hasPermission) {
                        startRecordingProcess();
                    } else {
                        showToast('Microphone permission denied.', true);
                    }
                }, () => showToast('Error requesting mic permission.', true));
            }
        });
    } else {
        startRecordingProcess();
    }
}

async function startRecordingProcess() {
    const recordBtn = document.getElementById('recordBtn');
    const recordLabel = document.getElementById('recordBtnLabel');
    const statusEl = document.getElementById('recordStatus');
    const statsEl = document.getElementById('recordingStats');
    const timeEl = document.getElementById('recordingTime');
    const charEl = document.getElementById('estimatedRecordingChars');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast('Recording is not supported in this browser.', true);
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                sampleRate: 16000,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });

        recordedChunks = [];
        const kbps = parseInt(audioQualitySlider.value);
        const bitrate = kbps * 1000;

        mediaRecorder = new MediaRecorder(stream, {
            mimeType: 'audio/webm;codecs=opus',
            audioBitsPerSecond: bitrate
        });

        mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                recordedChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = () => {
            stream.getTracks().forEach(track => track.stop());
            clearInterval(recordingInterval);
            statsEl.style.display = 'none';

            if (!recordedChunks.length) {
                showToast('No audio captured. Try again.', true);
                return;
            }
            recordedBlob = new Blob(recordedChunks, { type: 'audio/webm' });
            const audioEl = document.getElementById('recordedAudioPreview');
            const previewWrapper = document.getElementById('recordedAudioPreviewWrapper');
            const url = URL.createObjectURL(recordedBlob);
            audioEl.src = url;
            previewWrapper.style.display = 'block';
            document.getElementById('convertRecordedBtn').disabled = false;
            document.getElementById('recordStatus').textContent = 'Recording complete. Preview above.';
        };

        mediaRecorder.start(1000);
        isRecording = true;
        recordingStartTime = Date.now();
        recordLabel.textContent = 'Stop Recording';
        statusEl.textContent = 'Recording...';
        statsEl.style.display = 'flex';
        statsEl.classList.remove('limit-near', 'limit-hit');

        recordingInterval = setInterval(() => {
            recordingDuration = Math.floor((Date.now() - recordingStartTime) / 1000);
            timeEl.textContent = recordingDuration + 's';

            // Base64 estimation: (bitrate * seconds) / (8 bits * 0.75 ratio)
            // approx: kbps * 1000 * duration / 6
            const estimatedChars = Math.floor((kbps * 1000 * recordingDuration) / (8 * 0.75));
            charEl.textContent = estimatedChars.toLocaleString();

            const currentLimit = is100kEnabled ? 100000 : 90000;
            const limitDisplay = document.getElementById('maxCharLimitDisplay');
            if (limitDisplay) limitDisplay.textContent = currentLimit.toLocaleString();

            // Show/hide character count warning for audio recording
            const audioWarningElement = document.getElementById('audioCharCountWarning');
            if (estimatedChars > 20000) {
                audioWarningElement.style.display = 'block';
            } else {
                audioWarningElement.style.display = 'none';
            }

            if (estimatedChars >= currentLimit * 0.75) {
                statsEl.classList.add('limit-near');
            }

            if (estimatedChars >= currentLimit) {
                statsEl.classList.remove('limit-near');
                statsEl.classList.add('limit-hit');
                showToast('Character limit hit! Auto-stopping...', true);
                stopRecording();
            }
        }, 1000);

    } catch (err) {
        console.error(err);
        showToast('Could not start recording.', true);
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    isRecording = false;
    document.getElementById('recordBtnLabel').textContent = 'Start Recording';
    document.getElementById('recordStatus').textContent = 'Finishing recording...';
}

function convertRecordedAudioToBase64() {
    if (!recordedBlob) {
        showToast('Record some audio first.', true);
        return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
        const dataUrl = reader.result;
        const output = document.getElementById('recordedBase64Output');
        const countEl = document.getElementById('recordedCharCount');
        output.value = dataUrl;
        countEl.textContent = dataUrl.length.toLocaleString();

        // Show/hide character count warning for recorded audio result
        const recordedAudioWarningElement = document.getElementById('recordedAudioCharCountWarning');
        if (dataUrl.length > 20000) {
            recordedAudioWarningElement.style.display = 'block';
        } else {
            recordedAudioWarningElement.style.display = 'none';
        }

        const container = document.getElementById('recordedResultContainer');
        container.style.display = 'block';
        container.scrollIntoView({ behavior: 'smooth' });
    };
    reader.readAsDataURL(recordedBlob);
}

function copyRecordedBase64() {
    const textarea = document.getElementById('recordedBase64Output');
    textarea.select();
    try {
        navigator.clipboard.writeText(textarea.value);
        showToast('Recorded Base64 copied!');
    } catch (err) {
        showToast('Failed to copy.', true);
    }
}

function resetAudioToText() {
    if (isRecording) toggleRecording();
    recordedBlob = null;
    recordedChunks = [];
    document.getElementById('recordedAudioPreviewWrapper').style.display = 'none';
    document.getElementById('recordedAudioPreview').removeAttribute('src');
    document.getElementById('convertRecordedBtn').disabled = true;
    document.getElementById('recordedResultContainer').style.display = 'none';
    document.getElementById('recordedBase64Output').value = '';
    document.getElementById('recordStatus').textContent = 'Ready to record.';
}

// Character Limit Toggle Button


function toggleCharLimit() {
    is100kEnabled = !is100kEnabled;
    const currentLimit = is100kEnabled ? 100000 : 90000;
    const displayStr = currentLimit.toLocaleString();

    const elements = {
        btn: document.getElementById('charLimitBtn'),
        text: document.getElementById('limitBtnText'),
        icon: document.getElementById('limitBtnIcon'),
        limitDisplay: document.getElementById('maxCharLimitDisplay'),
        targetLabel: document.getElementById('targetLimitLabel')
    };

    if (elements.btn) elements.btn.classList.toggle('active', is100kEnabled);
    if (elements.text) elements.text.textContent = is100kEnabled ? '100k Limit Enabled' : 'Enable 100k Limit';
    if (elements.icon) elements.icon.textContent = is100kEnabled ? '✓' : '';
    if (elements.limitDisplay) elements.limitDisplay.textContent = displayStr;
    if (elements.targetLabel && convertMode !== 'smart') elements.targetLabel.textContent = displayStr;

    if (currentImage) updateEstimation();
}

// Dialog Management
function openInfo() {
    const dialog = document.getElementById('infoDialog');
    if (dialog) {
        dialog.showModal();
        history.pushState({ modal: 'info' }, '');
    }
}

function closeInfo() {
    const dialog = document.getElementById('infoDialog');
    if (dialog) {
        dialog.close();
    }
}

function openTutorial() {
    const dialog = document.getElementById('tutorialDialog');
    if (dialog) {
        dialog.showModal();
        history.pushState({ modal: 'tutorial' }, '');
    }
}

function closeTutorial() {
    const dialog = document.getElementById('tutorialDialog');
    const video = document.getElementById('tutorialVideo');
    if (dialog) {
        dialog.close();
    }
    if (video) {
        video.pause();
    }
}

function skipVideo(seconds) {
    const video = document.getElementById('tutorialVideo');
    if (video) {
        video.currentTime += seconds;
    }
}

// APK Dialog Logic
let currentStep = 1;
const stepImages = [
    "https://huggingface.co/roktimsardar123/cdn/resolve/main/1.jpg",
    "https://huggingface.co/roktimsardar123/cdn/resolve/main/2.jpg",
    "https://huggingface.co/roktimsardar123/cdn/resolve/main/3.jpg"
];

function handleApkDownload() {
    // Initiate Download
    const apkUrl = "https://huggingface.co/roktimsardar123/apps/resolve/main/Code%20My%20Image.apk";
    const link = document.createElement('a');
    link.href = apkUrl;
    link.download = "Code My Image.apk";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Open Dialog
    openApkDialog();
}

function openApkDialog() {
    const dialog = document.getElementById('apkDialog');
    if (dialog) {
        currentStep = 1;
        updateStepUI();
        dialog.showModal();
        history.pushState({ modal: 'apk' }, '');
    }
}

function closeApkDialog() {
    const dialog = document.getElementById('apkDialog');
    if (dialog) {
        dialog.close();
    }
}

function changeStep(n) {
    currentStep += n;
    if (currentStep < 1) currentStep = stepImages.length;
    if (currentStep > stepImages.length) currentStep = 1;
    updateStepUI();
}

function updateStepUI() {
    const img = document.getElementById('stepImage');
    const indicator = document.getElementById('stepIndicator');
    if (img) img.src = stepImages[currentStep - 1];
    if (indicator) indicator.textContent = `Step ${currentStep}/3`;
}

// Handle backdrop click and history sync
document.addEventListener('DOMContentLoaded', () => {
    const infoDialog = document.getElementById('infoDialog');
    const tutorialDialog = document.getElementById('tutorialDialog');
    const apkDialog = document.getElementById('apkDialog');

    const setupDialog = (dialog, closeFunc, stateName) => {
        if (!dialog) return;
        dialog.addEventListener('click', (e) => {
            const rect = dialog.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
                closeFunc();
            }
        });
        dialog.addEventListener('close', () => {
            if (history.state && history.state.modal === stateName) {
                history.back();
            }
        });
    };

    setupDialog(infoDialog, closeInfo, 'info');
    setupDialog(tutorialDialog, closeTutorial, 'tutorial');
    setupDialog(apkDialog, closeApkDialog, 'apk');
});

// Handle Back Button
window.addEventListener('popstate', (event) => {
    const infoDialog = document.getElementById('infoDialog');
    const tutorialDialog = document.getElementById('tutorialDialog');
    const apkDialog = document.getElementById('apkDialog');
    if (infoDialog && infoDialog.open) closeInfo();
    if (tutorialDialog && tutorialDialog.open) closeTutorial();
    if (apkDialog && apkDialog.open) closeApkDialog();
});

// Initialize UI Defaults
updateSmartBadge();
setSmartTargetLimit(smartPreset);
