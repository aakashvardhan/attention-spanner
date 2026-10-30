import { ring } from './bell';

/**
 * Played by the offscreen document background/focus.ts opens at each phase
 * change (#focus or #break). The document stays until the next chime closes it.
 */
ring(new AudioContext(), location.hash === '#break' ? 'break' : 'focus');
