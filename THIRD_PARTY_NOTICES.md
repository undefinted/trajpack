# Third-Party Notices

Trajpack is licensed under Apache-2.0. This file identifies material
third-party components used at runtime or bundled into release artifacts. It
does not change the license of Trajpack, and it is not a license for exported
datasets.

The authoritative dependency resolution is recorded in `pnpm-lock.yaml`.
Dependencies installed as separate npm packages retain their own `LICENSE` or
`COPYING` files. Copyright remains with their respective authors.

## Runtime and bundled components

| Component | Use | License |
| --- | --- | --- |
| Zod 4.4.3 | Canonical schema validation | MIT |
| libsodium.js (`libsodium-sumo` / `libsodium-wrappers-sumo` 0.7.16) | Local vault cryptography | ISC |
| `@dsnp/parquetjs` 1.8.9 and its runtime dependencies | HF/TRL Parquet export | MIT; transitive components also include Apache-2.0, BSD-3-Clause, ISC, 0BSD, BlueOak-1.0.0, and LGPL-3.0-or-later components as declared by their packages |
| fflate 0.8.3 | User-selected ZIP import | MIT |
| Fastify 5.12.0 and `@fastify/static` 10.1.3 | Loopback-only collector and reviewer server | MIT; transitive components also include BSD-3-Clause and ISC components as declared by their packages |
| Commander.js 14.0.3 | CLI argument parsing | MIT |
| React 19.2.8, React DOM 19.2.8, and Scheduler 0.27.0 | Bundled local reviewer UI | MIT |
| Vite 7.3.6 module-preload runtime | Build-generated reviewer bootstrap | MIT |

The Parquet dependency graph may include optional codecs or platform-specific
modules that are not loaded on every installation. Their inclusion in a lockfile
or installed dependency tree does not imply that Trajpack invokes a network or
cloud service.

## MIT License notice

The following notices identify the direct components resolved by the release
lockfile. The complete license text follows this list; separately installed npm
dependencies also retain the license files in their own packages.

- React, React DOM, and Scheduler: Copyright (c) Meta Platforms, Inc. and affiliates.
- Vite: Copyright (c) 2019-present, VoidZero Inc. and Vite contributors.
- Zod: Copyright (c) 2025 Colin McDonnell.
- Fastify: Copyright (c) 2016-present The Fastify team.
- `@fastify/static`: Copyright (c) 2017-present The Fastify team.
- Commander.js: Copyright (c) 2011 TJ Holowaychuk.
- fflate: Copyright (c) 2026 Arjun Barrett.
- `@dsnp/parquetjs`: portions Copyright (c) 2017 ironSource Ltd.; other
  portions are attributed to the ZJONSSON/parquetjs and LibertyDSNP/parquetjs
  contributors in the package's `LICENSE.md`.

Permission is hereby granted, free of charge, to any person obtaining a copy of
the software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ISC License notice

libsodium.js copyright (c) 2015-2026 Ahmad Ben Mrad, Frank Denis, and Ryan
Lester.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

For Apache-2.0, BSD-3-Clause, 0BSD, BlueOak-1.0.0, and LGPL-3.0-or-later
components, consult the license file shipped with the corresponding installed
package. Source and license locations are listed in each package's
`package.json` metadata.
