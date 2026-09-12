# Muzio Apple VLC dependencies

The Apple targets use official VideoLAN binaries. macOS remains on the stable
VLCKit 3.7.3 package, while iPhone and iPad use the official VLCKit 4.0.0-a24
package. The extracted frameworks are intentionally kept out of the
repository because they are large. Run `bash ios_app/scripts/prepare-vlckit.sh`
before an Xcode build. The setup script verifies each pinned SHA-256 digest and
downloads the archive over HTTPS when no local archive is available.

| Target | Official archive | SHA-256 | Selected platform slice |
| --- | --- | --- | --- |
| VLCKit | [VLCKit-3.7.3-319ed2c0-79128878.tar.xz](https://download.videolan.org/pub/cocoapods/prod/VLCKit-3.7.3-319ed2c0-79128878.tar.xz) | `019afdae4e2e2d0f3ac325fac8f7ba0af25dca70b9d157df7d60db88e0be8e5d` | `macos-arm64_x86_64` |
| VLCKit (iOS/iPadOS) | [VLCKit-4.0-20260831-1526.zip](https://download.videolan.org/cocoapods/unstable/VLCKit-4.0-20260831-1526.zip) | `c61a42052ec4c1315325fba81f8893f4ccf639d92bf61dd1b3c37c3a2f26b8e3` | `ios-arm64` and `ios-arm64_x86_64-simulator` |

The script writes the ignored runtime artifacts to this directory:

* `VLCKit.xcframework` for the macOS target.
* `VLCiOS/VLCKit.xcframework` for iPhone and iPad device/simulator targets.
* `licenses/VLCKit-COPYING.txt` and `licenses/VLCKit-iOS-COPYING.txt`, copied
  from each package's upstream `COPYING.txt`.

For the iOS ZIP, preparation copies only the XCFramework manifest, the two
iOS slices, and the license; tvOS, watchOS, visionOS, macOS, and debug-symbol
artifacts remain out of the extracted runtime directory.

Both packages carry the GNU Lesser General Public License, version 2.1
(LGPL-2.1). Keep the generated `licenses/` notices with any distribution of
the corresponding binary. The source package and license terms are provided
by [VideoLAN](https://www.videolan.org/legal.html).

The macOS framework is embedded at `Muzio.app/Contents/Frameworks`. Its
dylib ID is kept as
`@loader_path/../Frameworks/VLCKit.framework/Versions/A/VLCKit`, so the
standalone `build-macos.sh` artifact and the Xcode target resolve the same
app-relative framework. The standalone script copies the VLCKit notice to
`Contents/Resources/licenses/`; each Xcode target includes its corresponding
generated notice as a resource. Xcode's XCFramework support chooses the proper
VLCKit iOS device or simulator variant automatically.

These copied notices preserve the upstream license text. They are part of the
source and binary provenance recorded here; distribution obligations can also
depend on how the application and framework are delivered, so this setup note
does not make a broader legal compliance claim.
