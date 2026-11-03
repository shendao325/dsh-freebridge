import fs from 'node:fs'
import path from 'node:path'

const profileDir = 'C:/Users/test/.dsh/profiles/desktop'
const srcDir = 'C:/Users/test/Documents/deepseek-harness/default-workspace/dsh-freebridge'
const linkDir = path.join(profileDir, 'node_modules', 'dsh-freebridge')

// 1. 建链接（Windows 用 junction，不需要管理员权限）
if (fs.existsSync(linkDir)) {
  try { fs.unlinkSync(linkDir) } catch { fs.rmSync(linkDir, { recursive: true, force: true }) }
}
fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
fs.symlinkSync(srcDir, linkDir, 'junction')
console.log('linked:', linkDir, '->', srcDir)

// 2. 把包加进 profile 的依赖与 bundles 清单
const pkgFile = path.join(profileDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
pkg.dependencies = pkg.dependencies ?? {}
pkg.dependencies['dsh-freebridge'] = 'link:' + srcDir
const bundles = pkg.dsh?.profile?.bundles ?? []
if (!bundles.includes('dsh-freebridge')) bundles.push('dsh-freebridge')
pkg.dsh.profile.bundles = bundles
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log('bundles:', bundles.join(', '))
