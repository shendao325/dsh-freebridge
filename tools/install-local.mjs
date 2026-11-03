import fs from 'node:fs'
import path from 'node:path'

const profileDir = 'C:/Users/test/.dsh/profiles/desktop'
const srcDir = 'C:/Users/test/Documents/deepseek-harness/default-workspace/dsh-freebridge'
const destDir = path.join(profileDir, 'node_modules', 'dsh-freebridge')

/**
 * 用实体拷贝而不是软链接。
 *
 * 原因：Node 解析模块按「真实路径」走。软链接指向工作区时，
 * 插件里的 `import * as z from '@deepseek-ai/schemastery'` 会从工作区向上找，
 * 而宿主依赖在 profile/node_modules 里 —— 找不到，DSH 启动时直接崩。
 *
 * 拷贝到 profile/node_modules 后，resolve 命中 profile 的依赖，一切正常。
 */

const SKIP = new Set(['.git', 'node_modules', '.gitignore', 'tools'])

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(from, to)
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to)
    }
  }
}

// 先清掉旧的链接或目录
if (fs.existsSync(destDir)) {
  const stat = fs.lstatSync(destDir)
  if (stat.isSymbolicLink()) fs.unlinkSync(destDir)
  else fs.rmSync(destDir, { recursive: true, force: true })
}

copyDir(srcDir, destDir)
console.log('copied:', srcDir, '->', destDir)

// 更新 profile 依赖声明
const pkgFile = path.join(profileDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
pkg.dependencies = pkg.dependencies ?? {}
pkg.dependencies['dsh-freebridge'] = 'file:' + srcDir
const bundles = pkg.dsh?.profile?.bundles ?? []
if (!bundles.includes('dsh-freebridge')) bundles.push('dsh-freebridge')
pkg.dsh.profile.bundles = bundles
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log('bundles 已注册:', bundles.includes('dsh-freebridge'))

console.log('index.js 存在:', fs.existsSync(path.join(destDir, 'index.js')))
console.log('src 文件数:', fs.readdirSync(path.join(destDir, 'src')).length)
