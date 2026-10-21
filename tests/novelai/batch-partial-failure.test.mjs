import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as placements from '../../modules/draw/shared/scene-placement.js';
import { createSceneSource, normalizeMessageSceneSourceText } from '../../modules/draw/shared/scene-source.js';
import { createSerialImageRequestQueue } from '../../modules/draw/shared/serial-image-request-queue.js';

// Execute the real batch and chat orchestration without loading SillyTavern or contacting NAI.
const source = fs.readFileSync(new URL('../../modules/draw/providers/novelai/novel-draw.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function functionSource(name) {
    const start = source.indexOf(`async function ${name}(`);
    assert.ok(start >= 0);
    return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

function harness({ failed = [1], failureStoreThrows = false, failureRenderThrows = false } = {}) {
    const message = { mes: '第一幕。第二幕。第三幕。' };
    const ctx = { chatId: 'test-chat', chat: [message] };
    const requests = [], records = new Map(), selections = new Map(), cards = new Map(), saved = [];
    const tasks = [0, 1, 2].map(i => ({ scene: `scene-${i}`, placement: { mode: 'tail' } }));
    let nextId = 0;
    const queue = createSerialImageRequestQueue({ lockManager: null, documentRef: null });
    class NovelDrawError extends Error {}
    const deps = {
        ...placements, createSceneSource, normalizeMessageSceneSourceText, NovelDrawError,
        console: { log() {}, info() {}, warn() {}, error() {} },
        setTimeout: () => 1, clearTimeout() {},
        moduleInitialized: true, mvuActivityTracker: null,
        ErrorType: { AUTH: {}, ABORTED: {}, PARSE: {} }, ImageState: { PREVIEW: 'preview' },
        DEFAULT_SETTINGS: { timeout: 1000 }, DEFAULT_MESSAGE_FILTER_RULES: [],
        createGenerationJob: () => ({ controller: new AbortController() }), releaseGenerationJob() {},
        loadSettings: async () => {}, loadSharedDrawSettings: async () => {},
        getContext: () => ctx, getChatCharacterName: () => 'test', isMessageBeingEdited: () => false,
        getRuntimeSettings: () => ({ apiKey: 'test', sendMode: 'frontend' }),
        getActiveParamsPreset: () => ({ params: {} }), cloneSettingsObject: structuredClone,
        detectPresentCharacters: () => [], toScenePlannerProgress: () => ({}),
        buildNovelScenePlannerOptions: async () => ({}), generateAndParseScenePlan: async () => tasks,
        maybeAutoLearnFromTasks: async () => {}, ensureGenerationVibes: async () => ({}),
        generateSlotId: () => `slot-${++nextId}`, generateImgId: () => `img-${++nextId}`,
        getSceneSlotIds: () => [], createPlaceholder: id => `[image:${id}]`,
        rerenderChatMessage: async () => { cards.clear(); },
        renderSharedPreviewsForMessage: async () => {
            for (const [slotId, imgId] of selections) {
                if (message.mes.includes(`[image:${slotId}]`)) cards.set(slotId, records.get(imgId));
            }
        },
        insertPreviewIntoRenderedMessage: ({ slotId, html }) => { cards.set(slotId, html); return true; },
        buildPendingImageHtml: () => 'pending', buildImageHtml: () => 'success',
        buildFailedPlaceholderHtml: () => {
            if (failureRenderThrows) throw new Error('failure card render failed');
            return 'failed';
        },
        createNovelGenerationRecipe: () => ({}),
        compileNovelScenePlan: tasks => ({
            items: tasks.map(task => ({ request: { url: 'test', payload: { scene: task.scene } } })),
            artifacts: tasks.map(task => ({ task, promptData: { scene: task.scene } })),
        }),
        snapshotNovelRequestConfig: settings => settings,
        enqueueImageRequest: (run, options) => queue.enqueue(run, options),
        executePreparedNovelRequest: async prepared => {
            const index = requests.length;
            requests.push(prepared.payload.scene);
            if (failed.includes(index)) throw new Error(`NAI failed ${index}`);
            return `image-${index}`;
        },
        handleFetchError: error => error,
        classifyError: error => ({ code: 'network', label: '网络', desc: error.message }),
        storePreview: async record => { records.set(record.imgId, record); },
        storeFailedPlaceholder: async record => {
            if (failureStoreThrows) throw new Error('failure record write failed');
            records.set(record.imgId, { ...record, status: 'failed' });
        },
        setSlotSelection: async (slotId, imgId) => { selections.set(slotId, imgId); },
        clearSlotSelection: async slotId => { selections.delete(slotId); },
        deletePreview: async imgId => { records.delete(imgId); },
        buildNovelGenerationSnapshot: () => ({}), getPreviewDisplayUrl: () => 'data:image/png;base64,test',
        persistChatSilently: async () => { saved.push(message.mes); }, guardCommittedSlotsAgainstMvu() {},
    };
    vm.createContext(deps);
    vm.runInContext(`${functionSource('runNovelImageBatch')}\n${functionSource('runGenerateAndInsertImages')}`, deps);
    return { run: () => deps.runGenerateAndInsertImages({ messageId: 0 }), message, requests, records, cards, saved };
}

for (const failed of [[0], [1], [2], [0, 1, 2], []]) {
    test(`batch settles and commits each slot independently (failed: ${failed})`, async () => {
        const h = harness({ failed });
        const result = await h.run();
        assert.equal(h.requests.length, 3, 'all requests must run');
        assert.equal(result.success, 3 - failed.length);
        assert.equal(result.results.length, 3);
        assert.equal(h.records.size, 3);
        assert.equal(h.cards.size, 3);
        assert.equal(h.saved.length, 1);
        for (const item of result.results) assert.ok(h.message.mes.includes(`[image:${item.slotId}]`));
    });
}

for (const fault of ['failureStoreThrows', 'failureRenderThrows']) {
    test(`${fault}: failure handling must not stop later images or lose successful slots`, async () => {
        const h = harness({ [fault]: true });
        const result = await h.run();
        assert.equal(h.requests.length, 3);
        assert.equal(result.success, 2);
        const success = result.results.filter(item => item.success);
        assert.equal(success.length, 2);
        for (const item of success) {
            assert.ok(h.message.mes.includes(`[image:${item.slotId}]`));
            assert.ok(h.records.has(item.imgId));
            assert.ok(h.cards.has(item.slotId));
        }
        assert.equal((h.message.mes.match(/\[image:/g) || []).length, result.results.length, 'do not persist unresolved slots');
        assert.equal(h.cards.size, result.results.length, 'final DOM must contain only settled slots');
        assert.ok(h.saved.length > 0);
    });
}
