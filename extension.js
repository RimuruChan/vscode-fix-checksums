const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const sudo = require('sudo-prompt')
const tmp = require("tmp")

const appDir = path.dirname(process.argv[1])
const rootDir = path.join(appDir, '..')

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
  changed: verb => `Checksums ${verb}. Please restart VSCode to see effect.`,
  unchanged: 'No changes to checksums were necessary.',
  error: `An error occurred during execution.
Make sure you have write access rights to the VSCode files, see README`
}

function apply() {
  const product = require(productFile)
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
        moveFileAdmin(productFile, origFile)
          .then(() => writeFileAdmin(productFile, json))
          .catch(error => { throw error })
      }
      else writeFileAdmin(productFile, json)
      message = messages.changed('applied')
    } catch (err) {
      console.error(err)
      message = messages.error
    }
  }
  // Manual restart is required.
  // See https://github.com/RimuruChan/vscode-fix-checksums/pull/5#discussion_r1797303088
  vscode.window.showInformationMessage(message);
}

function restore() {
  let message = messages.unchanged
  let reload = false;
  try {
    if (fs.existsSync(origFile)) {
      deleteFileAdmin(productFile)
        .then(() => moveFileAdmin(origFile, productFile))
        .catch(error => { throw error })
      message = messages.changed('restored')
      reload = true;
    }
  } catch (err) {
    console.error(err)
    message = messages.error
  }
  // Manual restart is required.
  // See https://github.com/RimuruChan/vscode-fix-checksums/pull/5#discussion_r1797303088
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

function reloadWindow(message) {
  if (message === undefined) {
    console.info("Automatically reloading window for taking effect ...")
    vscode.commands.executeCommand('workbench.action.reloadWindow');
  } else {
    console.info("Reloading window manually is required ...");
    vscode.window.showInformationMessage(message, {
      title: "Reload Window"
    }).then(clicked => {
      if (clicked) {
        reloadWindow();
      }
    });
  }
}
