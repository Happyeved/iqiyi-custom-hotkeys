// ==UserScript==
// @name         爱奇艺快捷键设置（手动保存）
// @namespace    local.iqiyi.custom-hotkeys
// @version      1.0.0
// @description  独立原生设置弹窗，快捷键手动保存，长按倍速跟随爱奇艺菜单并显示加速提示。
// @match        *://*.iqiyi.com/*
// @match        *://iqiyi.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = 'iqiyi-custom-hotkeys-v1';
    const HOLD_DELAY = 350;
    // 原生播放器的长按默认项为 id="200"，即 2 倍；未确认时不能再写死为 3 倍。
    const FALLBACK_HOLD_RATE = 2;
    const nativeHoldRates = new WeakMap();
    const NATIVE_SPEED_SOURCE = '[data-ai-entity="倍速按钮"], .iqp-btn-speed, ' +
        '[data-player-hook="speed"], [data-ai-entity$="倍速浮层长按倍速入口"], ' +
        '[data-ai-entity="倍速浮层"], [data-ai-entity="长按倍速浮层"]';
    let holdRateSyncTimers = [];
    const ACTIONS = [
        ['play', '播放 / 暂停', 'Space'],
        ['back', '快退 5 秒', 'ArrowLeft'],
        ['forward', '快进 5 秒（单按）', 'ArrowRight'],
        ['volumeUp', '音量增加 5%', 'ArrowUp'],
        ['volumeDown', '音量降低 5%', 'ArrowDown'],
        ['previous', '上一集', 'Shift+KeyP'],
        ['next', '下一集', 'Shift+KeyN'],
        ['fullscreen', '进入 / 退出全屏', 'KeyF'],
        ['mute', '静音 / 取消静音', 'KeyM'],
        ['replay', '从头重播', 'Digit0'],
        ['exitFullscreen', '退出全屏', 'Escape'],
        ['hold', '长按倍速（跟随爱奇艺）', 'ArrowRight'],
    ];
    const DEFAULTS = Object.fromEntries(ACTIONS.map(([id, , key]) => [id, key]));
    const NATIVE_KEYS = new Set(Object.values(DEFAULTS));
    const MODIFIERS = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft',
        'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);
    const held = new Map();
    const volumeRoutes = new Map();
    let forwardingNativeVolume = 0;
    let active = { ...DEFAULTS };
    let draft = null;
    let ui = null;
    let boostIndicator = null;
    let lastErrorAt = -Infinity;
    let volumeOperation = 0;
    let volumeFeedbackTimer = null;

    function validBinding(value) {
        return typeof value === 'string' && (value === '' ||
            /^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:Meta\+)?(?:Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter|Equal|Comma)|Arrow(?:Left|Right|Up|Down)|F(?:[1-9]|1[0-9]|2[0-4])|Space|Enter|Escape|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen|CapsLock|NumLock|ScrollLock|Pause|PrintScreen|ContextMenu)$/.test(value));
    }

    function conflicts(bindings) {
        const seen = new Map();
        const errors = [];
        for (const [id, label] of ACTIONS) {
            const key = bindings[id];
            if (!validBinding(key)) {
                errors.push(`“${label}”的按键无效。`);
                continue;
            }
            if (!key) continue;
            const prior = seen.get(key);
            if (prior && !([id, prior.id].includes('hold') &&
                [id, prior.id].includes('forward'))) {
                errors.push(`“${label}”与“${prior.label}”重复：${displayKey(key)}`);
            } else if (!prior) {
                seen.set(key, { id, label });
            }
        }
        return errors;
    }

    try {
        const stored = GM_getValue(STORAGE_KEY, null);
        if (stored && stored.version === 1 && stored.bindings &&
            typeof stored.bindings === 'object') {
            const candidate = Object.fromEntries(ACTIONS.map(([id]) => [id,
                Object.prototype.hasOwnProperty.call(stored.bindings, id)
                    ? stored.bindings[id] : DEFAULTS[id]]));
            if (!conflicts(candidate).length) active = candidate;
        }
    } catch (error) {
        console.warn('[爱奇艺快捷键] 读取设置失败，暂用默认设置。', error);
    }

    function eventCode(event) {
        if (event.code) return event.code;
        if (/^[a-z]$/i.test(event.key)) return `Key${event.key.toUpperCase()}`;
        if (/^[0-9]$/.test(event.key)) return `Digit${event.key}`;
        return ({ ' ': 'Space', Esc: 'Escape', Left: 'ArrowLeft', Right: 'ArrowRight',
            Up: 'ArrowUp', Down: 'ArrowDown' })[event.key] || event.key;
    }

    function eventBinding(event) {
        return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt',
            event.shiftKey && 'Shift', event.metaKey && 'Meta', eventCode(event)]
            .filter(Boolean).join('+');
    }

    function displayKey(binding) {
        if (!binding) return '未绑定';
        const names = { Space: '空格', ArrowLeft: '←', ArrowRight: '→',
            ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Meta: '⌘ / Win',
            Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[',
            BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
            Comma: ',', Period: '.', Slash: '/' };
        return binding.split('+').map(part => names[part] ||
            part.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, '小键盘 '))
            .join(' + ');
    }

    function stop(event, preventDefault = true) {
        if (preventDefault) event.preventDefault();
        event.stopImmediatePropagation();
    }

    function isEditing(event) {
        return event.composedPath().some(node => node instanceof Element &&
            (node.matches('input, textarea, select, [role="textbox"], [role="combobox"]') ||
                node.isContentEditable));
    }

    function getVideo() {
        let best = null;
        let bestArea = 0;
        for (const video of document.querySelectorAll('video')) {
            const rect = video.getBoundingClientRect();
            const style = getComputedStyle(video);
            if (rect.width < 120 || rect.height < 60 || style.display === 'none' ||
                style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
            const area = rect.width * rect.height;
            if (area > bestArea) { best = video; bestArea = area; }
        }
        return best;
    }

    function playerRoot(video) {
        return video.closest('.iqp-player, #flashbox, #player, .qy-player-container, [data-player-hook="player"]') ||
            video.parentElement || video;
    }

    function getPlayerBridge() {
        // 爱奇艺当前 PC 播放器实际使用这个接口控制独立音频轨，并推送音量到界面。
        // Firefox 的油猴沙箱需要 unsafeWindow 才能访问页面对象。
        try {
            const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
            const wonder = page.webPlay && page.webPlay.wonder;
            if (!wonder || typeof wonder.getPCBridge !== 'function') return null;
            const bridge = wonder.getPCBridge();
            return bridge && typeof bridge.setVolume === 'function' ? bridge : null;
        } catch (error) {
            console.warn('[爱奇艺快捷键] 未能访问原生播放器接口。', error);
            return null;
        }
    }

    function getVolumeController(video) {
        const selector = '[data-ai-entity="播放器音量按钮"], [data-ai-entity="音量浮层内容区"], ' +
            '.iqp-btn-volume, [class*="_volumeLoud__"], [class*="_volumeLow__"], [class*="_volumeNone__"]';
        const scopes = [...new Set([video.closest('#video'), video.closest('#areaContainer'),
            playerRoot(video), document].filter(Boolean))];
        const seen = new Set();
        for (const scope of scopes) {
            for (const element of scope.querySelectorAll(selector)) {
                try {
                    const raw = element.wrappedJSObject || element;
                    const key = Object.keys(raw).find(name => name.startsWith('__reactFiber$') ||
                        name.startsWith('__reactInternalInstance$'));
                    let fiber = key && raw[key];
                    for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
                        const instance = fiber.stateNode;
                        if (!instance || seen.has(instance)) continue;
                        seen.add(instance);
                        // 精确匹配当前音量按钮组件，使用它连接的播放器，而非猜测全局实例。
                        if (typeof instance.onSetVal !== 'function' ||
                            typeof instance.renderVolumeContent !== 'function') continue;
                        const controller = instance.context && instance.context.playerCtrl;
                        if (controller && typeof controller.volume === 'function' &&
                            typeof controller.setVolume === 'function') return controller;
                    }
                } catch (error) {
                    console.warn('[爱奇艺快捷键] 读取音量按钮控制器失败。', error);
                }
            }
        }
        return null;
    }

    function showVolumeFeedback(message) {
        if (!ui && document.body) buildUI();
        if (!ui) return;
        // 复用默认样式按钮显示结果，不增加会影响暂停广告助手的遮罩或弹出层。
        ui.entry.textContent = `${message} · 快捷键设置`;
        clearTimeout(volumeFeedbackTimer);
        volumeFeedbackTimer = setTimeout(() => { ui.entry.textContent = '快捷键设置'; }, 2500);
    }

    function confirmVolume(operation, target, readBack) {
        const percent = value => Math.round(value * 10) / 10;
        showVolumeFeedback(`音量目标 ${percent(target)}%`);
        setTimeout(() => {
            if (operation !== volumeOperation) return;
            try {
                const actual = readBack();
                if (typeof actual !== 'number' || !Number.isFinite(actual)) {
                    showVolumeFeedback('音量未确认');
                } else if (Math.abs(actual - target) <= 0.5) {
                    showVolumeFeedback(`音量 ${percent(actual)}%`);
                } else {
                    showVolumeFeedback('音量未生效');
                }
            } catch (_) {
                showVolumeFeedback('音量未确认');
            }
        }, 180);
    }

    function adjustVolume(video, step) {
        const operation = ++volumeOperation;
        const controller = getVolumeController(video);
        if (controller) {
            // 网页音量按钮接口的单位是 0–100；底层 bridge 接口才是 0–1。
            const current = controller.volume().get();
            if (typeof current !== 'number' || !Number.isFinite(current)) {
                showVolumeFeedback('音量无法读取');
                return false;
            }
            const next = Math.max(0, Math.min(100, Math.round((current + step * 100) * 10) / 10));
            if (typeof controller.volumeEnable === 'function' &&
                typeof controller.setVolumeEnable === 'function' &&
                controller.volumeEnable().get() === false) controller.setVolumeEnable(true);
            controller.setVolume(next);
            confirmVolume(operation, next, () => controller.volume().get());
            return Math.abs(controller.volume().get() - next) <= 0.5;
        }
        return false;
    }

    function isPlainVolumeArrow(event) {
        const binding = eventBinding(event);
        return binding === 'ArrowUp' || binding === 'ArrowDown';
    }

    function forwardVolumeEvent(type, action, video, repeat = false) {
        const up = action === 'volumeUp';
        const code = up ? 'ArrowUp' : 'ArrowDown';
        const keyCode = up ? 38 : 40;
        const event = new KeyboardEvent(type, { key: code, code, keyCode, which: keyCode,
            bubbles: true, cancelable: true, composed: true, repeat,
            ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
        // 网站现行快捷键匹配同时检查 keyCode 和 code。
        for (const name of ['keyCode', 'which']) {
            if (event[name] !== keyCode) {
                try { Object.defineProperty(event, name, { value: keyCode }); } catch (_) { /* code 仍可匹配 */ }
            }
        }
        forwardingNativeVolume++;
        try {
            const root = playerRoot(video);
            (root.isConnected ? root : document.body).dispatchEvent(event);
        } finally { forwardingNativeVolume--; }
        return event;
    }

    function monitorNativeVolume(event, video) {
        const operation = ++volumeOperation;
        setTimeout(() => {
            if (operation !== volumeOperation) return;
            let value;
            try {
                const controller = getVolumeController(video);
                if (controller) value = controller.volume().get();
            } catch (_) { /* 结果提示不影响原生按键 */ }
            if (typeof value === 'number' && Number.isFinite(value)) {
                showVolumeFeedback(`音量 ${Math.round(value)}%`);
            } else if (event.defaultPrevented) {
                showVolumeFeedback('网页已接收音量键');
            } else {
                showVolumeFeedback('请使用原生 ↑/↓');
            }
        }, 0);
    }

    function handleVolumeKey(event, action, video, code) {
        // 默认按键保持真实事件和完整传播链，不调用全局 bridge，也不拦截 keyup。
        if (eventBinding(event) === DEFAULTS[action]) {
            monitorNativeVolume(event, video);
            return;
        }
        let owned = false;
        try {
            const forwarded = forwardVolumeEvent('keydown', action, video, event.repeat);
            owned = forwarded.defaultPrevented;
            if (owned) monitorNativeVolume(forwarded, video);
            else owned = adjustVolume(video, action === 'volumeUp' ? 0.05 : -0.05);
        } catch (error) {
            console.warn('[爱奇艺快捷键] 音量接管未完成，保留原生操作。', error);
        }
        volumeRoutes.set(code, { action, video, owned });
        // 只有网页确认处理，或当前音量控制器确认数值，才吞掉自定义按键。
        if (owned) stop(event);
        else showVolumeFeedback('请使用原生 ↑/↓');
    }

    function toggleMute(video) {
        const controller = getVolumeController(video);
        if (controller && typeof controller.mute === 'function' && typeof controller.setMute === 'function') {
            controller.setMute(!controller.mute().get());
            return;
        }
        const bridge = getPlayerBridge();
        if (bridge && typeof bridge.setMuted === 'function') {
            const muted = bridge.playInfo && typeof bridge.playInfo.mute === 'boolean'
                ? bridge.playInfo.mute : video.muted;
            bridge.setMuted(!muted);
        } else { video.muted = !video.muted; }
    }

    function parseNativeHoldRate(text) {
        // 必须紧跟“长按倍速”，不能把普通播放的 1.25X 等选项当成长按设置。
        const match = String(text || '').replace(/[\s\u200b-\u200d\ufeff]/g, '')
            .match(/长按倍速[:：]?(\d+(?:\.\d+)?)(?:[xX×]|倍)/);
        if (!match) return null;
        const rate = Number(match[1]);
        return Number.isFinite(rate) && rate >= 0.25 && rate <= 16 ? rate : null;
    }

    function rateFromNativeSpeedId(id) {
        // 普通倍速与长按倍速都是百分比 ID；仅读取明确名为 longPressSpeedId 的字段。
        if (!/^\d+$/.test(String(id ?? ''))) return null;
        const rate = Number(id) / 100;
        return Number.isFinite(rate) && rate >= 0.25 && rate <= 16 ? rate : null;
    }

    function holdRateFromComponent(video) {
        const scopes = [...new Set([video.closest('#video'), video.closest('#areaContainer'),
            playerRoot(video), document].filter(Boolean))];
        const seen = new Set();
        let propsRate = null;
        for (const scope of scopes) {
            for (const element of scope.querySelectorAll(NATIVE_SPEED_SOURCE)) {
                try {
                    const raw = element.wrappedJSObject || element;
                    const key = Object.getOwnPropertyNames(raw).find(name =>
                        name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
                    let fiber = key && raw[key];
                    for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
                        if (seen.has(fiber)) break;
                        seen.add(fiber);
                        const instance = fiber.stateNode;
                        if (instance && typeof instance.renderSpeedContent === 'function') {
                            const rate = rateFromNativeSpeedId(instance.state && instance.state.longPressSpeedId);
                            // 读取组件的当前 state，菜单关闭、DOM 卸载后仍然有效。
                            if (rate !== null) return rate;
                        }
                        const props = fiber.memoizedProps;
                        if (props && typeof props.onSelectLongPressSpeed === 'function') {
                            propsRate ??= rateFromNativeSpeedId(props.longPressSpeedId);
                        }
                    }
                } catch (_) { /* 沙箱或播放器版本不支持时，继续使用菜单读取。 */ }
            }
        }
        return propsRate;
    }

    function rateFromNativeLabel(text) {
        const match = String(text || '').trim().match(/^(\d+(?:\.\d+)?)\s*(?:[xX×]|倍)?$/);
        const rate = match && Number(match[1]);
        return rate && Number.isFinite(rate) && rate >= 0.25 && rate <= 16 ? rate : null;
    }

    function visibleNativeRateElement(element) {
        if (!element.getClientRects().length) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
    }

    function findNativeHoldRate(scope, includeText = true) {
        if (!scope) return null;
        // 先查长按二级菜单中真正选中的项，再查入口的数值；不读普通倍速列表。
        const selected = '[class*="longPressSpeedItemSelected__"], [class*="LongPressSpeedItemSelected__"]';
        const value = '[class*="longPressSpeedEntryValue__"], [class*="LongPressSpeedEntryValue__"]';
        for (const selector of [selected, value]) {
            for (const element of scope.querySelectorAll(selector)) {
                if (!visibleNativeRateElement(element)) continue;
                const rate = rateFromNativeLabel(element.textContent);
                if (rate !== null) return rate;
            }
        }
        if (!includeText) return null;
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (!/长按|倍速/.test(node.nodeValue || '')) continue;
            // 旧版菜单兼容：只接受“长按倍速 + 单个数值”的一行，避免读到列表首项 3 倍。
            let row = node.parentElement;
            for (let depth = 0; row && depth < 6; depth++, row = row.parentElement) {
                const text = row.textContent || '';
                if (text.length > 600) break;
                const compact = text.replace(/[\s\u200b-\u200d\ufeff]/g, '');
                if (!/^长按倍速[:：]?\d+(?:\.\d+)?(?:[xX×]|倍)[›»>→]?$/.test(compact)) continue;
                const rate = parseNativeHoldRate(text);
                if (rate === null) continue;
                if (visibleNativeRateElement(row)) return rate;
            }
        }
        return null;
    }

    function getNativeHoldRate(video) {
        if (!video) return { rate: FALLBACK_HOLD_RATE, detected: false };
        const root = playerRoot(video);
        const scopes = [...new Set([root, document.body].filter(Boolean))];
        let rate = null;
        for (const scope of scopes) {
            rate = findNativeHoldRate(scope, false);
            if (rate !== null) break;
        }
        if (rate === null) rate = holdRateFromComponent(video);
        if (rate === null) {
            for (const scope of scopes) {
                rate = findNativeHoldRate(scope);
                if (rate !== null) break;
            }
        }
        if (rate !== null) nativeHoldRates.set(root, rate);
        const cached = nativeHoldRates.get(root);
        return { rate: cached ?? FALLBACK_HOLD_RATE, detected: cached !== undefined };
    }

    function updateBoostIndicator(state) {
        if (!boostIndicator || boostIndicator.state !== state) return;
        const { host, label } = boostIndicator;
        const full = fullscreenElement();
        const parent = full && full.tagName !== 'VIDEO' ? full : document.body;
        if (parent && host.parentNode !== parent) parent.append(host);
        const rect = state.video.getBoundingClientRect();
        // 读取实际播放速度，避免提示中的倍数与视频不一致。
        const text = `${Number(state.video.playbackRate.toFixed(2))}倍快速播放中`;
        if (label.textContent !== text) label.textContent = text;
        host.style.left = `${rect.left + rect.width / 2}px`;
        host.style.top = `${rect.top + Math.min(32, Math.max(12, rect.height * 0.06))}px`;
        host.style.maxWidth = `${Math.max(0, rect.width - 24)}px`;
        host.style.display = rect.width > 0 && rect.height > 0 && rect.bottom > 0 &&
            rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
            ? 'block' : 'none';
    }

    function hideBoostIndicator(state) {
        if (!boostIndicator || boostIndicator.state !== state) return;
        const indicator = boostIndicator;
        cancelAnimationFrame(indicator.frame);
        indicator.frame = 0;
        indicator.host.style.display = 'none';
        indicator.state = null;
        for (const type of ['pause', 'ended', 'emptied', 'abort']) {
            state.video.removeEventListener(type, indicator.onInterrupted);
        }
        indicator.onInterrupted = null;
    }

    function showBoostIndicator(state) {
        if (!boostIndicator) {
            const host = document.createElement('div');
            host.id = 'iqiyi-hotkeys-boost-indicator';
            host.setAttribute('aria-hidden', 'true');
            host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;display:none;pointer-events:none;transform:translateX(-50%);';
            const shadow = host.attachShadow({ mode: 'open' });
            make('style', ':host{pointer-events:none!important} span{display:block;box-sizing:border-box;padding:8px 14px;border-radius:5px;background:rgba(0,0,0,.65);color:white;font:500 16px/1.5 system-ui,sans-serif;text-align:center;user-select:none;pointer-events:none}', shadow);
            const label = make('span', '', shadow);
            boostIndicator = { host, label, state: null, frame: 0, onInterrupted: null };
        }
        const indicator = boostIndicator;
        if (indicator.state) hideBoostIndicator(indicator.state);
        indicator.state = state;
        indicator.onInterrupted = () => finishHeld(state, false);
        for (const type of ['pause', 'ended', 'emptied', 'abort']) {
            state.video.addEventListener(type, indicator.onInterrupted);
        }
        function tick() {
            if (indicator.state !== state) return;
            indicator.frame = 0;
            if (!state.video.isConnected || document.hidden || state.video.ended ||
                (ui && ui.dialog.open)) {
                finishHeld(state, false);
                return;
            }
            updateBoostIndicator(state);
            // 仅在长按加速期间跟随视频的位置、全屏容器和实际倍数。
            indicator.frame = requestAnimationFrame(tick);
        }
        tick();
    }

    function syncNativeHoldRate(video) {
        const info = getNativeHoldRate(video);
        if (!info.detected) return;
        for (const state of held.values()) {
            if (!state.boosting || state.video !== video) continue;
            try {
                // 长按期间若用户还修改了普通播放倍速，松开时保留这次选择。
                if (video.playbackRate !== state.appliedRate) state.oldRate = video.playbackRate;
                state.appliedRate = info.rate;
                if (video.playbackRate !== info.rate) video.playbackRate = info.rate;
                updateBoostIndicator(state);
            } catch (error) { console.warn('[爱奇艺快捷键] 同步长按倍速失败。', error); }
        }
    }

    function reportError(error) {
        console.warn('[爱奇艺快捷键]', error);
        if (performance.now() - lastErrorAt < 1500) return;
        lastErrorAt = performance.now();
        window.alert(`爱奇艺快捷键：${error.message || error}`);
    }

    function run(action, video) {
        try {
            const result = perform(action, video);
            if (result && typeof result.catch === 'function') result.catch(reportError);
        } catch (error) { reportError(error); }
    }

    function seek(video, offset) {
        const end = Number.isFinite(video.duration) ? video.duration : Infinity;
        video.currentTime = Math.max(0, Math.min(end, video.currentTime + offset));
    }

    function fullscreenElement() {
        return document.fullscreenElement || document.webkitFullscreenElement;
    }

    function exitFullscreen() {
        if (!fullscreenElement()) return;
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) return exit.call(document);
    }

    function findControl(video, selectors) {
        // 优先限定在当前播放器内；不通过模糊的全页文字点击推荐视频。
        const root = playerRoot(video);
        for (const scope of root === document ? [root] : [root, document]) {
            for (const selector of selectors) {
                for (const element of scope.querySelectorAll(selector)) {
                    if (element.disabled || element.getAttribute('aria-disabled') === 'true' ||
                        element.classList.contains('disabled') || !element.getClientRects().length) continue;
                    return element;
                }
            }
        }
        return null;
    }

    function episodeId(item) {
        return String(item && (item.qipu_id ?? item.tvId ?? item.tvid ?? item.qipuId) || '');
    }

    function episodeNumber(item) {
        const value = item && (item.number ?? item.album_order ?? item.itemNumber);
        const number = Number(value);
        return Number.isInteger(number) && number > 0 ? number : null;
    }

    function adjacentEpisode(list, currentId, direction) {
        const index = list.findIndex(item => episodeId(item) === String(currentId));
        if (index < 0) return null;
        const currentNumber = episodeNumber(list[index]);
        if (currentNumber !== null) {
            const wanted = currentNumber + (direction === 'next' ? 1 : -1);
            // 按集数找，支持列表倒序，也不会跳到中间的预告/花絮。
            return list.find(item => episodeNumber(item) === wanted && episodeId(item)) || null;
        }
        return list[index + (direction === 'next' ? 1 : -1)] || null;
    }

    const EPISODE_GROUPS = '.episode-container, [class*="episodesNew_episodeContent__"], ' +
        '[data-ai-entity="数字选集列表"], [data-ai-entity="文案选集列表"]';
    const EPISODE_SELECTED = '[class*="episodesNew_itemChecked__"], [class*="episodes_playing__"], ' +
        '[aria-current="true"], [aria-current="page"], .album_item.on, .album_item.selected';

    function switchEpisodeFromComponent(direction) {
        // 当前 React 版的选集组件保留整季数据；使用其原生 onClick 可跨越列表分页。
        // 只查选集区域，不访问推荐视频，也不把“历史返回”当成上一集。
        const seen = new Set();
        for (const group of document.querySelectorAll(EPISODE_GROUPS)) {
            const raw = group.wrappedJSObject || group;
            const key = Object.keys(raw).find(name => name.startsWith('__reactFiber$') ||
                name.startsWith('__reactInternalInstance$'));
            let fiber = key && raw[key];
            for (let depth = 0; fiber && depth < 50; depth++, fiber = fiber.return) {
                const instance = fiber.stateNode;
                if (!instance || seen.has(instance)) continue;
                seen.add(instance);
                if (!instance.props || !instance.props.data || !instance.props.data.feature_paged ||
                    typeof instance.onClick !== 'function') continue;
                const list = instance.allPageData;
                const currentId = instance.state && instance.state.currentTvid;
                if (!Array.isArray(list) || !currentId || !list.some(item => episodeId(item) === String(currentId))) continue;
                const target = adjacentEpisode(list, currentId, direction);
                if (!target) throw new Error(direction === 'previous'
                    ? '当前选集数据中没有上一集。若不是第一集，请展开完整选集后重试。'
                    : '当前选集数据中没有下一集。');
                // target 是网站自己的数据对象；让网站正常处理可播放状态、会员和切集。
                instance.onClick(target);
                return true;
            }
        }
        return false;
    }

    function numberOnEpisodeElement(element) {
        const label = element.getAttribute('data-ai-entity') || '';
        const match = label.match(/^第\s*(\d+)\s*集$/) ||
            (element.textContent || '').trim().match(/^(\d+)$/);
        return match ? Number(match[1]) : null;
    }

    function switchEpisodeFromList(direction) {
        const groups = [...document.querySelectorAll(EPISODE_GROUPS)];
        for (const group of groups) {
            const selected = group.querySelector(EPISODE_SELECTED);
            if (!selected) continue;
            const currentNumber = numberOnEpisodeElement(selected);
            if (currentNumber === null) continue;
            const wanted = currentNumber + (direction === 'next' ? 1 : -1);
            const rows = group.querySelectorAll('[data-ai-entity^="第"][data-ai-entity$="集"], ' +
                '[class*="episodesNew_item__"], [class*="episodesNew_itemChecked__"], .album_item');
            const target = [...rows].find(row => numberOnEpisodeElement(row) === wanted &&
                row.getAttribute('aria-disabled') !== 'true' && !row.disabled);
            if (target) { target.click(); return true; }
        }
        return false;
    }

    function changeEpisode(video, direction) {
        const control = findControl(video, direction === 'next'
            ? ['.iqp-btn-next', '[data-player-hook="next"]', '[data-player-hook="nextVideo"]']
            : ['.iqp-btn-prev', '.iqp-btn-previous', '[data-player-hook="previous"]', '[data-player-hook="prev"]']);
        if (control) { control.click(); return; }
        if (switchEpisodeFromComponent(direction) || switchEpisodeFromList(direction)) return;
        throw new Error(`未找到${direction === 'previous' ? '上一集' : '下一集'}。请先展开爱奇艺的选集列表，再按快捷键。`);
    }

    function perform(action, video) {
        switch (action) {
        case 'play': return video.paused || video.ended ? video.play() : video.pause();
        case 'back': return seek(video, -5);
        case 'forward': return seek(video, 5);
        case 'volumeUp': return adjustVolume(video, 0.05);
        case 'volumeDown': return adjustVolume(video, -0.05);
        case 'mute': return toggleMute(video);
        case 'replay': video.currentTime = 0; return video.play();
        case 'previous': return changeEpisode(video, 'previous');
        case 'next': return changeEpisode(video, 'next');
        case 'exitFullscreen': return exitFullscreen();
        case 'fullscreen': {
            if (fullscreenElement()) return exitFullscreen();
            const control = findControl(video, ['.iqp-btn-fullscreen', '[data-player-hook="fullscreen"]']);
            if (control) { control.click(); return; }
            const target = playerRoot(video);
            const request = target.requestFullscreen || target.webkitRequestFullscreen;
            if (!request) throw new Error('当前浏览器不支持网页全屏接口。');
            return request.call(target);
        }
        }
    }

    function finishHeld(state, allowTap) {
        // 播放请求可能稍后才失败，不能让旧请求结束新一轮长按。
        if (held.get(state.code) !== state) return;
        clearTimeout(state.timer);
        held.delete(state.code);
        hideBoostIndicator(state);
        if (state.boosting) {
            state.boosting = false;
            try {
                state.video.playbackRate = state.oldRate;
                if (state.wasPaused) state.video.pause();
            } catch (error) { console.warn('[爱奇艺快捷键] 恢复倍速失败。', error); }
        } else if (state.isHold && allowTap && state.tap && state.video.isConnected) {
            run(state.tap, state.video);
        }
    }

    function releaseAll() {
        for (const state of [...held.values()]) finishHeld(state, false);
        for (const route of volumeRoutes.values()) {
            try { forwardVolumeEvent('keyup', route.action, route.video); } catch (_) { /* 页面可能正在卸载 */ }
        }
        volumeRoutes.clear();
    }

    function beginHold(state) {
        state.timer = setTimeout(() => {
            if (held.get(state.code) !== state || !state.video.isConnected || document.hidden ||
                (ui && ui.dialog.open)) return;
            state.oldRate = state.video.playbackRate;
            state.wasPaused = state.video.paused;
            state.boosting = true;
            try {
                const info = getNativeHoldRate(state.video);
                state.appliedRate = info.rate;
                state.video.playbackRate = info.rate;
                if (state.wasPaused) {
                    const playing = state.video.play();
                    if (playing && typeof playing.catch === 'function') {
                        playing.catch(error => { finishHeld(state, false); reportError(error); });
                    }
                }
                showBoostIndicator(state);
            } catch (error) { finishHeld(state, false); reportError(error); }
        }, HOLD_DELAY);
    }

    function captureBinding(event, input) {
        stop(event);
        const code = eventCode(event);
        if (MODIFIERS.has(code) || event.repeat || event.isComposing) return;
        // Tab 保留为面板焦点导航；清空有独立按钮，不占用 Delete/Backspace。
        if (code === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
            setSettingsMessage('Tab 用于切换面板焦点，请选择其他按键。');
            return;
        }
        const binding = eventBinding(event);
        if (!validBinding(binding)) {
            setSettingsMessage('这个按键暂不支持，请选择其他按键。');
            return;
        }
        draft[input.dataset.action] = binding;
        updateFields();
        const errors = conflicts(draft);
        setSettingsMessage(errors.length ? errors.join('；') : '');
    }

    function onKeyDown(event) {
        if (forwardingNativeVolume) return;
        if (ui && ui.dialog.open) {
            const input = event.composedPath().find(node => node instanceof HTMLInputElement &&
                node.dataset.action);
            if (input && eventCode(event) !== 'Tab') captureBinding(event, input);
            else stop(event, false);
            return;
        }
        if (event.isComposing || event.keyCode === 229 || isEditing(event)) return;
        const code = eventCode(event);
        const volumeRoute = volumeRoutes.get(code);
        if (volumeRoute) {
            handleVolumeKey(event, volumeRoute.action, volumeRoute.video, code);
            return;
        }
        const existing = held.get(code);
        if (existing) {
            stop(event);
            if (!existing.isHold && ['back', 'forward'].includes(existing.tap)) {
                run(existing.tap, existing.video);
            }
            return;
        }
        const video = getVideo();
        if (!video) return;
        const binding = eventBinding(event);
        const tap = ACTIONS.find(([id]) => id !== 'hold' && active[id] && active[id] === binding)?.[0];
        const isHold = Boolean(active.hold && active.hold === binding);
        if (tap === 'volumeUp' || tap === 'volumeDown') {
            handleVolumeKey(event, tap, video, code);
            return;
        }
        // 音量接管的兜底入口：未绑定其它功能的默认方向键始终留给网页。
        if (!tap && !isHold && isPlainVolumeArrow(event)) return;
        if (!tap && !isHold && !NATIVE_KEYS.has(binding)) return;
        stop(event);
        if (event.repeat || (!tap && !isHold)) return;
        const state = { code, video, tap, isHold, boosting: false, timer: null };
        held.set(code, state);
        if (isHold) beginHold(state);
        else if (tap) run(tap, video);
    }

    function onKeyUp(event) {
        if (forwardingNativeVolume) return;
        const route = volumeRoutes.get(eventCode(event));
        if (route) {
            volumeRoutes.delete(eventCode(event));
            try { forwardVolumeEvent('keyup', route.action, route.video); } catch (_) { /* 保留物理按键 */ }
            if (route.owned) stop(event);
            return;
        }
        const state = held.get(eventCode(event));
        if (state) {
            stop(event);
            finishHeld(state, !(ui && ui.dialog.open) && !isEditing(event));
            return;
        }
        if (ui && ui.dialog.open) { stop(event, false); return; }
        if (event.isComposing || isEditing(event) || !getVideo()) return;
        if (isPlainVolumeArrow(event)) return;
        const binding = eventBinding(event);
        if (NATIVE_KEYS.has(binding) || Object.values(active).includes(binding)) stop(event);
    }

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('keypress', event => {
        if (forwardingNativeVolume) return;
        if (ui && ui.dialog.open) { stop(event, false); return; }
        if (event.isComposing || isEditing(event) || !getVideo()) return;
        const route = volumeRoutes.get(eventCode(event));
        if (route) { if (route.owned) stop(event); return; }
        if (isPlainVolumeArrow(event)) return;
        const binding = eventBinding(event);
        if (held.has(eventCode(event)) || NATIVE_KEYS.has(binding) ||
            Object.values(active).includes(binding)) stop(event);
    }, true);
    window.addEventListener('blur', releaseAll);
    window.addEventListener('pagehide', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
    // 等网页完成菜单更新后再读取；缓存只在内存中，不会自动保存快捷键设置。
    function queueNativeHoldRateSync(event) {
        if (ui && event.composedPath().includes(ui.host)) return;
        const video = getVideo();
        if (!video) return;
        for (const timer of holdRateSyncTimers) clearTimeout(timer);
        holdRateSyncTimers = [];
        for (const delay of [0, 150, 400]) {
            holdRateSyncTimers.push(setTimeout(() => {
                if (video.isConnected) syncNativeHoldRate(video);
            }, delay));
        }
    }
    window.addEventListener('click', queueNativeHoldRateSync, true);
    window.addEventListener('mouseover', event => {
        if (event.composedPath().some(node => node instanceof Element && node.matches(NATIVE_SPEED_SOURCE))) {
            queueNativeHoldRateSync(event);
        }
    }, true);

    function make(tag, text, parent) {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (parent) parent.append(element);
        return element;
    }

    function button(text, parent, callback) {
        const element = make('button', text, parent);
        element.type = 'button';
        element.addEventListener('click', callback);
        return element;
    }

    function updateFields() {
        for (const [id, input] of ui.fields) input.value = displayKey(draft[id]);
    }

    function setSettingsMessage(text) {
        ui.message.textContent = text;
        ui.message.hidden = !text;
    }

    function closeSettings() {
        if (ui && ui.dialog.open) ui.dialog.close();
        if (ui && typeof ui.entry.blur === 'function') ui.entry.blur();
        draft = null;
    }

    function saveSettings() {
        const errors = conflicts(draft);
        if (errors.length) { setSettingsMessage(errors.join('；')); return; }
        const next = { ...draft };
        try {
            // 全脚本唯一的写入位置：只有用户点击“保存”才会执行。
            GM_setValue(STORAGE_KEY, { version: 1, bindings: next });
        } catch (error) {
            setSettingsMessage(`保存失败，设置尚未应用：${error.message || error}`);
            return;
        }
        releaseAll();
        active = next;
        closeSettings();
    }

    function openSettings() {
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', openSettings, { once: true });
            return;
        }
        if (!ui) buildUI();
        if (ui.dialog.open) return;
        releaseAll();
        draft = { ...active };
        updateFields();
        setSettingsMessage('');
        getNativeHoldRate(getVideo());
        ui.dialog.showModal();
        ui.cancel.focus();
    }

    function buildUI() {
        if (ui) return;
        const host = document.createElement('div');
        host.id = 'iqiyi-custom-hotkeys-panel';
        // 仅设置位置与尺寸；弹窗、按钮及表单保留浏览器默认外观。
        host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:80px;z-index:2147483647;';
        const shadow = host.attachShadow({ mode: 'open' });
        const style = make('style', ':host{color-scheme:normal} dialog{max-width:calc(100vw - 48px);max-height:85vh;overflow:auto} table{border-spacing:8px 5px} th{text-align:left} input{width:180px;max-width:38vw}', shadow);
        const entry = button('快捷键设置', shadow, openSettings);
        const dialog = make('dialog', undefined, shadow);
        dialog.setAttribute('aria-labelledby', 'iqhk-title');
        make('h3', '爱奇艺快捷键设置（v1.0.0）', dialog).id = 'iqhk-title';
        make('p', '点选输入框后按下单键或组合键。清空表示取消该项的脚本绑定。', dialog);
        make('p', '快进与长按倍速可以共用一个键；其他重复绑定无法保存。', dialog);
        const table = make('table', undefined, dialog);
        const header = make('tr', undefined, make('thead', undefined, table));
        for (const text of ['功能', '快捷键', '操作']) make('th', text, header);
        const tbody = make('tbody', undefined, table);
        const fields = new Map();
        for (const [id, label] of ACTIONS) {
            const row = make('tr', undefined, tbody);
            make('td', label, row);
            const input = make('input', undefined, make('td', undefined, row));
            input.type = 'text';
            input.readOnly = true;
            input.autocomplete = 'off';
            input.dataset.action = id;
            input.setAttribute('aria-label', label);
            input.title = '点击后直接按下要设置的快捷键';
            fields.set(id, input);
            button('清空', make('td', undefined, row), () => {
                draft[id] = '';
                updateFields();
                setSettingsMessage('');
            }).setAttribute('aria-label', `清空${label}`);
        }
        const message = make('p', '', dialog);
        message.setAttribute('role', 'status');
        message.hidden = true;
        const footer = make('p', undefined, dialog);
        button('保存', footer, saveSettings);
        footer.append(' ');
        const cancel = button('取消', footer, closeSettings);
        footer.append(' ');
        button('恢复默认', footer, () => {
            draft = { ...DEFAULTS };
            updateFields();
            setSettingsMessage('');
        });
        dialog.addEventListener('close', () => { draft = null; });
        ui = { host, shadow, entry, dialog, fields, message, cancel, style };
        document.body.append(host);
        function positionEntry() {
            const full = fullscreenElement();
            const parent = full && full.tagName !== 'VIDEO' ? full : document.body;
            if (parent && host.parentNode !== parent) parent.append(host);
        }
        document.addEventListener('fullscreenchange', positionEntry);
        document.addEventListener('webkitfullscreenchange', positionEntry);
        positionEntry();
    }

    GM_registerMenuCommand('爱奇艺：快捷键设置', openSettings);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildUI, { once: true });
    } else { buildUI(); }
})();
