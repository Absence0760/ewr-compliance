// MapLibre, loaded only when the map is drawn: EwrMap imports this file dynamically, so the
// other routes do not carry it. The worker is served as a plain asset from the site itself:
// maplibre-gl 6.13+ ships it as one self-contained module, so `?url` needs no bundler config.
import { Map as MapLibreMap, Marker, NavigationControl, Popup, addProtocol, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

setWorkerUrl(workerUrl);

let pmtiles: Promise<void> | null = null;
/** The `pmtiles://` protocol, registered once and only when there is a base map to read. */
export function usePmtiles(): Promise<void> {
	pmtiles ??= import('pmtiles').then(({ Protocol }) => {
		addProtocol('pmtiles', new Protocol().tile);
	});
	return pmtiles;
}

export { MapLibreMap, Marker, NavigationControl, Popup };
