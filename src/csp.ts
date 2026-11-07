// The content security policy's connect-src, built by vite.config.ts. docs/hosting.md § Content security
// policy explains each origin. Kept here, beside the app, so a test pins it.

/** The live ArcGIS services the map reads: DWS quaternary catchments and basins, and flow gauges. */
export const ARCGIS_ORIGINS = ['https://services3.arcgis.com', 'https://services8.arcgis.com'] as const;

/**
 * The site itself, which serves data/, geo/, tiles/ and the DWS store under dws/, the ArcGIS services, and
 * the base map's host when VITE_TILES_URL or VITE_TILES_GLYPHS_URL is a full URL elsewhere. Nothing else:
 * the browser calls no other site, and a flow file stays in it.
 */
export function connectSrc(env: Record<string, string | undefined>): string[] {
	const tiles = [env.VITE_TILES_URL, env.VITE_TILES_GLYPHS_URL]
		.map((v) => v?.trim() ?? '')
		.filter((v) => /^https:\/\//i.test(v))
		.map((v) => new URL(v).origin);
	return [...new Set(['self', ...ARCGIS_ORIGINS, ...tiles])];
}
