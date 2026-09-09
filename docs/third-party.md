# Bundled playback runtime and source

Offgrid's own source is [MIT licensed](../LICENSE). Bundled dependencies retain their own licenses. In particular, the Homebrew build of mpv includes GPL components; the MIT license does not replace their terms. Offgrid launches mpv as a separate executable and controls it through its IPC interface.

macOS installers include mpv and its non-system dynamic libraries, including the MoltenVK driver loaded by Vulkan. They do not require Homebrew on the recipient's computer. The installer includes `Contents/Resources/mpv/THIRD-PARTY-NOTICES.txt`, per-component license and copyright texts in `licenses/`, and manifests describing the copied files and exact installed formula versions.

Every release that contains this runtime must also distribute the corresponding `mpv-sources-<Offgrid version>-<architecture>.tar.gz` asset from the same [GitHub release](https://github.com/Matt-Mc/OffGrid/releases). Keep this source asset available for as long as the installer is offered. A link to an upstream project's current source branch is not a substitute for the matching source archive.

## How sources are collected

Run on the same machine and Homebrew installation used to bundle the runtime:

```sh
brew install mpv
npm run bundle:mpv
npm run bundle:mpv-sources
```

The bundler follows the actual Mach-O library dependencies instead of copying all installed Homebrew packages. The source collector loads each copied library's **installed** `.brew` formula recipe through Homebrew, checks its version against the runtime manifest, and saves:

- Its upstream source archive, with the SHA256 from that installed recipe checked before use.
- Formula resources and patches, including embedded patches. Git resources are fetched at the exact recorded commit, with their pinned submodules included.
- Homebrew-local patch files at the immutable Homebrew/core commit recorded by the matching installed bottle manifest. The bottle receipt's source timestamp, Homebrew/compiler version, and architecture must match. When the local bottle manifest cache is absent, the collector fetches a bounded set of rebuild manifests for that exact installed version from Homebrew's public registry; missing provenance stops collection.
- The installed build recipe and installation receipt, a source inventory with SHA256 hashes, and available upstream license/copyright notices.
- Offgrid's runtime relocation script and binary manifest.

The `fast_float` headers compiled into libplacebo and the `vulkan-headers` registry used to generate its Vulkan bindings are included as supplemental inputs. The Vulkan headers used by vulkan-loader are also included. Each supplemental recipe comes from the immutable Homebrew/core revision associated with its consuming bottle. General build tools are not collected merely because they are installed. Resources explicitly declared inside a bundled formula are included, since its build recipe may use them to generate or compile distributed code.

Collection fails if a source lacks a checksum or exact commit, a checksum is wrong, a recipe/version differs, a patch cannot be recovered, or a component has no license/copyright notice. `vendor/mpv/sources-manifest.json` is marked complete only after the source archive is created. Packaging checks that marker and its binding to the runtime manifest. `vendor/mpv-sources/` is a local download cache and is not part of the app or Git repository.

## Building or modifying the runtime

Extract the matching source asset first. Each `<formula>-<version>/` directory contains its Homebrew `.rb` recipe, `INSTALL_RECEIPT.json`, `sources.json`, and downloaded source/resource/patch archives. The receipt records the original OS/compiler, build options, and dependency versions. The recipe's `install` method records the configuration flags and commands, and the collected patches preserve Homebrew changes. Git archives already include submodule working trees and omit `.git` history; their adjacent JSON file records the commit and submodule revisions.

Use a compatible macOS/Xcode toolchain and Homebrew to build those exact recipes from source. Install matching runtime dependencies first; Homebrew's standard build tools such as Meson, Ninja, CMake, and pkg-config may also be needed as specified by each recipe. A Homebrew tap containing these recipes can be used with `brew install --build-from-source <tap>/<formula>`; place any `Patches/...` files at their recorded relative paths in the tap. The saved archives are also usable directly with the upstream build instructions, applying the recorded patches and configuration flags from the recipe. This archive records the original build inputs; it does not claim byte-identical reproduction across different compilers or OS releases.

After rebuilding, run `npm run bundle:mpv` in the Offgrid checkout to copy the new runtime, relocate library references relative to mpv, and sign the copied Mach-O files. Run source collection again before packaging. A modified runtime has new hashes and requires a new source inventory. The app resolves the bundled `mpv/bin/mpv` before searching the user's PATH.

## Windows managed player

Windows installers do not contain the Mac/Homebrew runtime. On first launch, the Windows x64 app downloads the pinned baseline x86_64 archive directly from [shinchiro's mpv builds](https://github.com/shinchiro/mpv-winbuild-cmake/releases/tag/20260903). Its archive and extracted executable/DLL hashes are recorded in `electron/managed-mpv.cjs`. Only `mpv.exe` and `d3dcompiler_43.dll` are extracted; upstream installer and updater scripts are not run. The downloaded runtime stays in the user's application data folder for offline playback.

Setup also downloads the checksum-pinned `7zr.exe` standalone extractor directly from the [official 7-Zip 26.03 release](https://github.com/ip7z/7zip/releases/tag/26.03). It verifies the extractor before execution and deletes the temporary copy afterward. The same upstream release provides its corresponding source.

The current mpv build imports `vulkan-1.dll` even when using another renderer. Setup downloads the [official LunarG runtime components](https://sdk.lunarg.com/sdk/download/1.4.357.0/windows/VulkanRT-X64-1.4.357.0-Components.zip), verifies the archive and x64 loader hash, and places that DLL and `VulkanRT-License.txt` beside mpv. The loader source is maintained in [KhronosGroup/Vulkan-Loader](https://github.com/KhronosGroup/Vulkan-Loader). This is a private app runtime; setup does not install system graphics drivers. Windows player, extractor, and Vulkan binaries are not included in Offgrid's installer.

See the [upstream build project](https://github.com/shinchiro/mpv-winbuild-cmake) and [mpv copyright/license](https://github.com/mpv-player/mpv/blob/master/Copyright) for that runtime's build and license information. The Mac corresponding-source collection requirements above continue to apply to the bundled Mac runtime.

## Other dependencies

Electron, Chromium, Node.js, and JavaScript dependencies retain their own notices in the packaged application and upstream packages. yt-dlp and the separately managed download FFmpeg binary have their own distribution and license terms; this document describes the **bundled playback runtime**, including FFmpeg libraries that mpv links against.

References: [mpv copyright and license](https://github.com/mpv-player/mpv/blob/master/Copyright), [Homebrew formula cookbook](https://docs.brew.sh/Formula-Cookbook), and the exact component license texts included in each installer/source archive.
