const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const sudo = require('sudo-prompt')
const tmp = require("tmp")

const rootDir = vscode.env.appRoot
const appDir = path.join(rootDir, 'out')

const productFile = path.join(rootDir, 'product.json')
const origFile = `${productFile}.orig.${vscode.version}`

exports.activate = function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('fixChecksums.apply', apply),
    vscode.commands.registerCommand('fixChecksums.restore', restore)
  )
  cleanupOrigFiles()
}

const messages = {
  // A manual restart is required, as reloading will not take effect.
  changed: verb => `Checksums ${verb}. Please restart VSCode to see effect.`,
  unchanged: 'No changes to checksums were necessary.',
  error: `An error occurred during execution.
Make sure you have write access rights to the VSCode files, see README`,
}

async function apply() {
  const product = requireUncached(productFile)
  if (!product.checksums) {
    vscode.window.showInformationMessage(messages.unchanged)
  }
  let changed = false
  let message = messages.unchanged
  for (const [filePath, curChecksum] of Object.entries(product.checksums)) {
    const checksum = computeChecksum(path.join(appDir, ...filePath.split('/')))
    if (checksum !== curChecksum) {
      product.checksums[filePath] = checksum
      changed = true
    }
  }
  if (changed) {
    const json = JSON.stringify(product, null, '\t')
    try {
      if (!fs.existsSync(origFile)) {
        await moveFile(productFile, origFile)
      }
      await writeFile(productFile, json)
      message = messages.changed('applied')
    } catch (err) {
      console.error(err)
      message = messages.error
    }
  }
  vscode.window.showInformationMessage(message);
}

async function restore() {
  let message = messages.unchanged
  try {
    if (fs.existsSync(origFile)) {
      await deleteFile(productFile)
      await moveFile(origFile, productFile)
      message = messages.changed('restored')
    }
  } catch (err) {
    console.error(err)
    message = messages.error
  }
  vscode.window.showInformationMessage(message);
}

function computeChecksum(file) {
  var contents = fs.readFileSync(file)
  return crypto
    .createHash('sha256')
    .update(contents)
    .digest('base64')
    .replace(/=+$/, '')
}

function cleanupOrigFiles() {
  // Remove all old backup files that aren't related to the current version
  // of VSCode anymore.
  const oldOrigFiles = fs.readdirSync(rootDir)
    .filter(file => /\.orig\./.test(file))
    .filter(file => !file.endsWith(vscode.version))
  for (const file of oldOrigFiles) {
    deleteFileAdmin(path.join(rootDir, file))
  }
}

function writeFile(filePath, writeString, encoding = "UTF-8") {
  return new Promise((resolve, reject) => {
    try {
      fs.writeFileSync(filePath, writeString, encoding)
      resolve()
    } catch (err) {
      console.error(err)
      writeFileAdmin(filePath, writeString, encoding).then(resolve).catch(reject)
    }
  })
}

function writeFileAdmin(filePath, writeString, encoding = "UTF-8", promptName = "File Writer") {
  console.info("Writing file with administrator privileges ...");
  return new Promise((resolve, reject) => {
    tmp.file((err, tmpPath) => {
      if (err) reject(err)
      else fs.writeFile(tmpPath, writeString, encoding, err => {
        if (err) reject(err)
        else sudo.exec(
          (process.platform === "win32" ? "copy /y " : "cp -f ") + `"${tmpPath}" "${filePath}"`,
          { name: promptName },
          error => {
            if (error) reject(error)
            else resolve()
          })
      })
    })
  })
}

function deleteFile(filePath) {
  return new Promise((resolve, reject) => {
    try {
      fs.unlinkSync(filePath)
      resolve()
    } catch (err) {
      console.error(err)
      deleteFileAdmin(filePath).then(resolve).catch(reject)
    }
  })
}

function deleteFileAdmin(filePath, promptName = "File Deleter") {
  console.info("Deleting file with administrator privileges ...");
  return new Promise((resolve, reject) => {
    sudo.exec(
      (process.platform === "win32" ? "del /f /q " : "rm -f ") + `"${filePath}"`,
      { name: promptName },
      error => {
        if (error) reject(error)
        else resolve()
      }
    )
  })
}

function moveFile(filePath, newPath) {
  return new Promise((resolve, reject) => {
    try {
      fs.renameSync(filePath, newPath)
      resolve()
    } catch (err) {
      console.error(err)
      moveFileAdmin(filePath, newPath).then(resolve).catch(reject)
    }
  })
}

function moveFileAdmin(filePath, newPath, promptName = "File Renamer") {
  console.info("Renaming file with administrator privileges ...");
  return new Promise((resolve, reject) => {
    sudo.exec(
      (process.platform === "win32" ? "move /y " : "mv -f ") + `"${filePath}" "${newPath}"`,
      { name: promptName },
      error => {
        if (error) reject(error)
        else resolve()
      }
    )
  })
}

function requireUncached(module) {
  delete require.cache[require.resolve(module)];
  return require(module);
}
