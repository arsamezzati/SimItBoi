/**
 * Gives the packaged exe its icon and name.
 *
 * electron-builder normally does this itself, but only by unpacking a toolkit
 * whose archive holds symbolic links, which Windows refuses to create without
 * administrator rights or Developer Mode. So packaging leaves the exe alone
 * (`signAndEditExecutable: false`) and this hook edits it with rcedit instead,
 * which needs neither.
 */
import { join } from 'node:path'
import { rcedit } from 'rcedit'

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const { productName, buildVersion } = context.packager.appInfo
  const exe = join(context.appOutDir, productName + '.exe')
  await rcedit(exe, {
    icon: join(context.packager.info.buildResourcesDir, 'icon.ico'),
    'file-version': buildVersion,
    'product-version': buildVersion,
    'version-string': {
      ProductName: productName,
      FileDescription: productName,
      OriginalFilename: productName + '.exe',
      InternalName: productName
    }
  })
}
