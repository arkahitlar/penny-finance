// Generate from checked-in web assets so building does not depend on a deployment.
const fs = require('node:fs/promises');
const path = require('node:path');
const { TwaGenerator, TwaManifest, ConsoleLog } = require('@bubblewrap/core');
const { fetchUtils } = require('@bubblewrap/core/dist/lib/FetchUtils');

async function main() {
  const config = JSON.parse(await fs.readFile(path.join(__dirname, 'twa-manifest.json'), 'utf8'));
  const sources = new Map([
    [config.iconUrl, ['icons/icon-512.png', 'image/png']],
    [config.maskableIconUrl, ['icons/maskable-512.png', 'image/png']],
    [config.webManifestUrl, ['manifest.webmanifest', 'application/manifest+json']],
  ]);
  fetchUtils.fetch = async (input) => {
    const source = sources.get(String(input));
    if (!source) throw new Error(`Unexpected build asset: ${input}`);
    return new Response(await fs.readFile(path.join(__dirname, '../public', source[0])), {
      status: 200, headers: { 'Content-Type': source[1] },
    });
  };
  const manifest = new TwaManifest(config);
  const invalid = manifest.validate();
  if (invalid) throw new Error(invalid);
  await new TwaGenerator().createTwaProject(__dirname, manifest, new ConsoleLog('Penny'));
  // Use current Maven repositories and the installed stable SDK tools.
  const rootGradle = path.join(__dirname, 'build.gradle');
  await fs.writeFile(rootGradle, (await fs.readFile(rootGradle, 'utf8')).replaceAll('jcenter()', 'mavenCentral()'));
  const appGradle = path.join(__dirname, 'app/build.gradle');
  await fs.writeFile(appGradle, (await fs.readFile(appGradle, 'utf8'))
    .replace('compileSdkVersion 36', "compileSdkVersion 36\n    buildToolsVersion '36.0.0'"));
  // The wrapper keeps no user data itself; all account data lives on the web origin.
  const androidManifest = path.join(__dirname, 'app/src/main/AndroidManifest.xml');
  await fs.writeFile(androidManifest, (await fs.readFile(androidManifest, 'utf8'))
    .replace('android:allowBackup="true"', 'android:allowBackup="false" android:usesCleartextTraffic="false"'));
  console.log('Generated Penny Android project from local web assets.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
