# Third-party notices

This inventory covers the direct production dependencies and runtime components
of the Code City 1.0.0 container. It is informational and does not replace the
license text shipped with each component.

## npm production dependencies

| Component | Version | License |
| --- | ---: | --- |
| `fflate` | 0.8.3 | MIT |
| `ignore` | 7.0.6 | MIT |
| `jsonc-parser` | 3.3.1 | MIT |
| `three` | 0.185.1 | MIT |
| `typescript` and its platform adapter | 7.0.2 | Apache-2.0 |

Their package license files remain in the installed production `node_modules`
tree. Transitive production dependencies, if introduced later, are governed by
their own package licenses and must be included in the release audit.

## Container runtime

The release container also includes Node.js 24, the .NET 10 runtime, Git,
OpenSSH client, Debian/Ubuntu runtime packages, and their transitive system
libraries. Those components remain under their respective upstream licenses.
The image retains the package-manager copyright and license material under
`/usr/share/doc`; Node.js and .NET license material is retained in their
installed runtime trees.

The two Code City .NET helper projects have no external NuGet package
references beyond the selected .NET framework/runtime.

## Build and test tooling

Development-only npm packages, SDK images, GitHub Actions, QEMU, BuildKit, and
browser binaries are not distributed as application dependencies. They remain
subject to their own licenses in development and CI environments.
