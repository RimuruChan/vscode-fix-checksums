const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const sudo = require('@expo/sudo-prompt')
const tmp = require('tmp')

const rootDir = vscode.env.appRoot
const appDir = path.join(rootDir, 'out')
const productFile = path.join(rootDir, 'product.json')
const origFile = `${productFile}.orig.${vscode.version}`

let output

exports.activate = function activate(context) {
  output = vscode.window.createOutputChannel('Fix VSCode Checksums')
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('fixChecksums.apply', apply),
    vscode.commands.registerCommand('fixChecksums.restore', restore)
  )

  cleanupOrigFiles().catch(logError)

  if (vscode.workspace.getConfiguration().get('checksums.autoFix')) {
    // Other UI extensions can patch workbench files during startup.
    setTimeout(() => apply(true), 3000)
  }
}

async function apply(automatic = false) {
  try {
    const product = readJson(productFile)
    const entries = Object.entries(product.checksums || {})
    if (entries.length === 0) throw new Error(`No checksums found in ${productFile}`)

    let changed = false
    for (const [filePath, currentChecksum] of entries) {
      const target = path.join(appDir, ...filePath.split('/'))
      const checksum = computeChecksum(target)
      if (checksum !== currentChecksum) {
        product.checksums[filePath] = checksum
        changed = true
        output.appendLine(`Updated: ${filePath}`)
      }
    }

    if (!changed) {
      if (!automatic) vscode.window.showInformationMessage('No checksum changes were necessary.')
      return
    }

    if (!fs.existsSync(origFile)) await copyFile(productFile, origFile)
    await writeFile(productFile, `${JSON.stringify(product, null, '\t')}\n`)

    // Do not report success unless the privileged write really reached disk.
    const saved = readJson(productFile)
    for (const [filePath, checksum] of Object.entries(product.checksums)) {
      if (saved.checksums?.[filePath] !== checksum) {
        throw new Error(`Verification failed after writing ${productFile}`)
      }
    }

    vscode.window.showInformationMessage('Checksums applied. Fully quit and restart VS Code to see the effect.')
  } catch (error) {
    await showError('Could not apply checksums', error)
  }
}

async function restore() {
  try {
    if (!fs.existsSync(origFile)) {
      vscode.window.showInformationMessage('No checksum backup exists for this VS Code version.')
      return
    }
    await copyFile(origFile, productFile)
    readJson(productFile)
    vscode.window.showInformationMessage('Original checksums restored. Fully quit and restart VS Code.')
  } catch (error) {
    await showError('Could not restore checksums', error)
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function computeChecksum(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64').replace(/=+$/, '')
}

async function cleanupOrigFiles() {
  const oldOrigFiles = fs.readdirSync(rootDir)
    .filter(file => file.startsWith('product.json.orig.'))
    .filter(file => file !== path.basename(origFile))

  for (const file of oldOrigFiles) {
    try {
      await deleteFile(path.join(rootDir, file))
    } catch (error) {
      logError(error)
    }
  }
}

async function writeFile(filePath, contents, encoding = 'utf8') {
  try {
    fs.writeFileSync(filePath, contents, encoding)
  } catch (error) {
    if (!isPermissionError(error)) throw error
    await withTempFile(contents, encoding, tmpPath => runElevated(copyCommand(tmpPath, filePath), 'Fix VSCode Checksums'))
  }
}

async function copyFile(source, destination) {
  try {
    fs.copyFileSync(source, destination)
  } catch (error) {
    if (!isPermissionError(error)) throw error
    await runElevated(copyCommand(source, destination), 'Fix VSCode Checksums')
  }
}

async function deleteFile(filePath) {
  try {
    fs.unlinkSync(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') return
    if (!isPermissionError(error)) throw error
    await runElevated(deleteCommand(filePath), 'Fix VSCode Checksums')
  }
}

function withTempFile(contents, encoding, callback) {
  return new Promise((resolve, reject) => {
    tmp.file((error, tmpPath, fd, cleanup) => {
      if (error) return reject(error)
      fs.writeFile(tmpPath, contents, encoding, async writeError => {
        if (writeError) {
          cleanup()
          return reject(writeError)
        }
        try {
          await callback(tmpPath)
          resolve()
        } catch (callbackError) {
          reject(callbackError)
        } finally {
          cleanup()
        }
      })
    })
  })
}

function runElevated(command, name) {
  output.appendLine('Requesting administrator privileges...')
  return new Promise((resolve, reject) => {
    sudo.exec(command, { name }, error => error ? reject(error) : resolve())
  })
}

function copyCommand(source, destination) {
  if (process.platform === 'win32') return `copy /y ${quote(source)} ${quote(destination)}`
  return `cp -f -- ${quote(source)} ${quote(destination)}`
}

function deleteCommand(filePath) {
  if (process.platform === 'win32') return `del /f /q ${quote(filePath)}`
  return `rm -f -- ${quote(filePath)}`
}

function quote(value) {
  if (process.platform === 'win32') return `"${String(value).replace(/"/g, '""')}"`
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

function isPermissionError(error) {
  return error && (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS')
}

function logError(error) {
  output?.appendLine(error?.stack || String(error))
}

async function showError(prefix, error) {
  logError(error)
  const detail = error?.message || String(error)
  const action = await vscode.window.showErrorMessage(`${prefix}: ${detail}`, 'Show Log')
  if (action === 'Show Log') output.show(true)
}
