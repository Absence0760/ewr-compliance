# Notice

The MIT licence in `LICENSE` covers this project's source code. It does not cover the data below, which keeps its own terms.

| Data | Source | Terms |
|---|---|---|
| Quaternary catchments | Weepener HL, van den Berg HM, Metz M and Hamandawana H (2012), updated 2018. Department of Water and Sanitation service. | Loaded live in the browser and not stored in this repository, because DWS supplies this data without distribution rights. |
| Water Management Area boundaries: the WMAs of 2023, and the basin outlines (WMAs of 2004) | Department of Water and Sanitation service. | Loaded live in the browser and not stored in this repository, for the same reason. `tools/build-rivers.ts` reads the 2023 outlines to sort rivers by WMA, and writes none of them. |
| Flow gauges | South African Hydropower Atlas (Water Research Commission and University of Pretoria), Active and Inactive Gauging Weirs, taken from DWS reports. Author: University of Pretoria. | Loaded live in the browser and not stored in this repository. The layer is offered for download, with the author acknowledged. |
| Daily flow at the linked gauges (the "DWS (kept current)" source) | Department of Water and Sanitation, verified daily flow (HyData), copyright DWS. Pulled by `pipeline/` into the site's own store. | Not in this repository: kept behind the sign-in, and stored only with DWS's permission for this tool. Never sold or redistributed. |
| Rivers (`static/geo/rivers-<wma>.json`) | Department of Water and Sanitation, Resource Quality Services, 1:500 000 rivers, primary and secondary, read from the `Rivers` layer of the DWS ArcGIS service. Simplified to about 50 m, and split by WMA. | State copyright, data in the public domain. Source acknowledged, as the metadata asks: Department of Water and Sanitation, Resource Quality Services (formerly IWQS). |
| Reserve Desktop and Revised Desktop outputs, flow series, gauge records, node tables | Supplied project files, DWS monthly volumes, and published Government Gazettes. Not in this repository. They are kept in a private repository and copied to `static/data` by `pnpm data:private`. | Not licensed under MIT. All rights remain with their owners. |
| Sample dataset and flow files (`e2e/fixtures`, and `static/data` after `pnpm data:sample`) | Invented for the tests by the scripts beside them. Nothing in them is measured or comes from a supplied file. | MIT, as source code. |

No warranty is given for any of this data. Check it against the original source before relying on it for a decision.

## Third-party code

Runtime libraries keep their own licences: SvelteKit and Svelte (MIT), MapLibre GL JS (BSD-3-Clause), uPlot (MIT), SheetJS (Apache-2.0).
