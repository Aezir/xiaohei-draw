import { getRequestHeaders } from '../../../../../script.js';
import { debounce } from '../../../../utils.js';
import { StorageFile } from './storage-file.js';

const createStorage = (filename, opts = {}) => new StorageFile(filename, {
    ...opts,
    getRequestHeaders,
    debounce,
});

export const TasksStorage = createStorage('XBDraw_Tasks.json');
export const StoryOutlineStorage = createStorage('XBDraw_StoryOutline.json');
export const NovelDrawStorage = createStorage('XBDraw_NovelDraw.json', { debounceMs: 800 });
export const SdDrawStorage = createStorage('XBDraw_SdDraw.json', { debounceMs: 800 });
export const ComfyDrawStorage = createStorage('XBDraw_ComfyDraw.json', { debounceMs: 800 });
export const AssistantStorage = createStorage('XBDraw_Assistant.json', { debounceMs: 800 });
export const TtsStorage = createStorage('XBDraw_TTS.json', { debounceMs: 800 });
export const EnaPlannerStorage = createStorage('XBDraw_EnaPlanner.json', { debounceMs: 800 });
export const CommonSettingStorage = createStorage('XBDraw_CommonSettings.json', { debounceMs: 1000 });
export const VectorStorage = createStorage('XBDraw_Vectors.json', { debounceMs: 3000 });
