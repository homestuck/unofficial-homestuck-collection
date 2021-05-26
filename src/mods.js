import fs from 'fs'
import path from 'path'

const {ipcMain, ipcRenderer, dialog} = require('electron')

const Store = require('electron-store')
const store = new Store()

const log = require('electron-log');
const logger = log.scope('Mods');

const assetDir = store.has('localData.assetDir') ? store.get('localData.assetDir') : undefined
const modsDir = path.join(assetDir, "mods")
const modsAssetsRoot = "assets://mods/"

var modChoices
var routes = undefined

function getAssetRoute(url) {
  // If the asset url `url` should be replaced by a mod file,
  // returns the path of the mod file. 
  // Otherwise, returns undefined.

  // Lazily bake routes as needed instead of a init hook
  if (routes == undefined) bakeRoutes()

  console.assert(url.startsWith("assets://"), "mods", url)

  const file_route = routes[url]
  if (file_route) logger.debug(url, "to", file_route)
  return file_route
}

function getTreeRoutes(tree, parent=""){
  let routes = []
  for (const name in tree) {
    const dirent = tree[name]
    const subpath = (parent ? parent + "/" + name : name)
    if (dirent == true) {
      // Path points to a file of some sort
      routes.push(subpath)
    } else {
      // Recurse through subpaths
      routes = routes.concat(getTreeRoutes(dirent, subpath))
    }
  }
  return routes
}

var onModLoadFail;

if (ipcMain) {
  onModLoadFail = function (enabled_mods, e) {
    logger.info("Mod load failure with issues in", enabled_mods)
    logger.error(e)
    clearEnabledMods()
    // TODO: Replace this with a good visual traceback so users can diagnose mod issues
    
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'Mod load error',
      message: "Something went wrong while loading mods! All mods have been disabled for safety.\nCheck the console log for details"
    })
  }
} else {
  // We are in the renderer process.
  onModLoadFail = function (enabled_mods, e) {
    logger.info("Mod load failure with modlist", enabled_mods)
    logger.debug(e)
    clearEnabledMods()
    logger.error("Did not expect to be in the renderer process for this! Debug")
    throw e 
  }
}

function bakeRoutes() {
  const enabled_mods = getEnabledMods()
  logger.info("Baking routes for", enabled_mods)
  let all_mod_routes = {}
  // Start with least-priority so they're overwritten
  getEnabledModsJs().reverse().forEach(js => {
    try {
      // Lower priority: Auto routes
      if (js.trees) {
        console.assert(!js._singlefile, js.title, "Single file mods cannot use treeroute!")
        
        for (const mod_tree in js.trees) {
          const asset_tree = js.trees[mod_tree] 

          console.assert(mod_tree.endsWith("/"), mod_tree, "Tree paths must be directories! (end with /)")
          console.assert(asset_tree.endsWith("/"), asset_tree, "Tree paths must be directories! (end with /)")
          console.assert(asset_tree.startsWith("assets://"), asset_tree, "Asset paths must be on the assets:// protocol!")

          const treeroutes = getTreeRoutes(crawlFileTree(path.join(js._mod_root_dir, mod_tree), true))
          treeroutes.forEach(route => {
            all_mod_routes[asset_tree + route] =
              new URL(path.posix.join(mod_tree, route), js._mod_root_url).href
          })
        }
      }
      
      // Higher priority: manual routes
      for (const key in js.routes || {}) {
        const local = new URL(js.routes[key], js._mod_root_url).href
        console.assert(!(js._singlefile && local.includes(js._mod_root_url)), js.title, "Single file mods cannot use local route!")
                
        all_mod_routes[key] = local
      }
    } catch (e) {
      logger.error(e)
    }
  })
  
  // Modify script-global `routes`
  routes = all_mod_routes

  // Test routes
  // TODO: This is super wasteful and should only be done when developer mode is on.

  const Resources = require("@/resources.js")
  if (Resources.isReady()) {
    Object.keys(all_mod_routes).forEach(url => {
      try {
        Resources.resolveURL(url)
      } catch (e) {
        logger.warn("Testing routes failed")
        onModLoadFail([url], e)
      }
    })
  }
}

const store_modlist_key = 'localData.settings.modListEnabled'

function getEnabledMods() {
  // Get modListEnabled from settings, even if vue is not loaded yet.
  const list = store.has(store_modlist_key) ? store.get(store_modlist_key) : []
  return list
}

function clearEnabledMods() {
  // TODO: This doesn't trigger the settings.modListEnabled observer,
  // which results in bad settings-screen side effects
  store.set(store_modlist_key, [])
  logger.debug("Modlist cleared.")
  bakeRoutes()
}

function getEnabledModsJs() {
  return getEnabledMods().map((dir) => getModJs(dir))
}

function crawlFileTree(root, recursive=false) {
  // Gives a object that represents the file tree, starting at root
  // Values are objects for directories or true for files that exist
  const dir = fs.opendirSync(root)
  let ret = {}
  let dirent
  while (dirent = dir.readSync()) {
    if (dirent.isDirectory()) {
      if (recursive) {
        const subpath = path.join(root, dirent.name)
        ret[dirent.name] = crawlFileTree(subpath, true)
      } else ret[dirent.name] = undefined // Is directory, but not doing a recursive scan
    } else {
      ret[dirent.name] = true
    }
  }
  dir.close()
  return ret
}

function getModJs(mod_dir, singlefile=false) {
  // Tries to load a mod from a directory
  // If mod_dir/mod.js is not found, tries to load mod_dir.js as a single file
  // Errors passed to onModLoadFail and raised
  try {
    let modjs_path
    if (singlefile) {
      modjs_path = path.join(modsDir, mod_dir)
    } else {
      modjs_path = path.join(modsDir, mod_dir, "mod.js")
    }
    var mod = __non_webpack_require__(modjs_path)
    mod._id = mod_dir
    mod._singlefile = singlefile

    if (!singlefile) {
      mod._mod_root_dir = path.join(modsDir, mod._id)
      mod._mod_root_url = new URL(mod._id, modsAssetsRoot).href + "/"
    }

    return mod
  } catch (e1) {
    // elaborate error checking w/ afllback
    const e1_is_notfound = (e1.code && e1.code == "MODULE_NOT_FOUND")
    if (singlefile) {
      if (e1_is_notfound) {
        // Tried singlefile, missing
        throw e1
      } else {
        // Singlefile found, other error
        logger.error("Singlefile found, other error 1")
        onModLoadFail([mod_dir], e1)
        throw e1
      }
    } else if (e1_is_notfound) {
      // Tried dir/mod.js, missing
      try {
        // Try to find singlefile
        return getModJs(mod_dir, true)
      } catch (e2) {
        const e2_is_notfound = (e2.code && e2.code == "MODULE_NOT_FOUND")
        if (e2_is_notfound) {
          // Singlefile not found either
          logger.error(mod_dir, "is missing required file 'mod.js'")
          onModLoadFail([mod_dir], e2)
        } else {
          logger.error("Singlefile found, other error 2")
          onModLoadFail([mod_dir], e2)
        } 
        // finally
        throw e2
      }
    } else {
      // dir/mod.js found, other error
      onModLoadFail([mod_dir], e1)
      throw e1
    }
  }
}

// Interface

function editArchive(archive) {
  // edit(archive)
  getEnabledModsJs().reverse().forEach((js) => {
    const editfn = js.edit
    if (editfn) {
      editfn(archive)
      console.assert(archive, js.title, "You blew it up! You nuked the archive!")
    }
  })

  archive.footnotes = {}

  // Footnotes
  getEnabledModsJs().reverse().forEach((js) => {
    if (js.footnotes) {
      if (typeof js.footnotes == "string") {
        console.assert(!js._singlefile, js.title, "Single file mods cannot use footnote files!")
        
        const json_path = path.join(
          js._mod_root_dir, 
          js.footnotes
        )

        logger.info(js.title, "Loading footnotes from file", json_path)
        const footObj = JSON.parse(
          fs.readFileSync(json_path, 'utf8')
        )
        mergeFootnotes(archive, footObj)
      } else if (Array.isArray(js.footnotes)) {
        logger.info(js.title, "Loading footnotes from object")
        mergeFootnotes(archive, js.footnotes)
      } else {
        throw new Error(js.title, `Incorrectly formatted mod. Expected string or array, got '${typeof jsfootnotes}'`)
      }
    }
  })
}

function mergeFootnotes(archive, footObj) {
  if (!Array.isArray(footObj)) {
    throw new Error(`Incorrectly formatted mod. Expected string or array, got '${typeof jsfootnotes}'`)
  }

  footObj.forEach(footnoteList => {
    const default_author = footnoteList.author || "Undefined Author"
    const default_class = footnoteList.class || undefined

    for (var page_num in footnoteList.footnotes) {
      // TODO replace this with some good defaultdict juice
      if (!archive.footnotes[page_num])
        archive.footnotes[page_num] = []

      footnoteList.footnotes[page_num].forEach(note => {
        const new_note = {
          author: (note.author === null) ? null : (note.author || default_author),
          class: (note.class === null) ? null : (note.class || default_class),
          content: note.content
        }

        archive.footnotes[page_num].push(new_note)
      })
    }
  })
}

function getMainMixin(){
  // A mixin that injects on the main vue process.
  // Currently this just injects custom css

  let styles = []
  getEnabledModsJs().forEach(js => {
    const modstyles = js.styles || []
    modstyles.forEach(style_link => styles.push(new URL(style_link, js._mod_root_url).href))
  })

  return {
    mounted() {
      logger.debug("Mounted main mixin")

      styles.forEach((style_link) => {
        const link = document.createElement("link")
        link.rel = "stylesheet"
        link.type = "text/css"
        link.href = style_link

        this.$el.appendChild(link)
        logger.debug(link)
      })
    }
  }
}

function getMixins(){
  // This is absolutely black magic
  const nop = () => undefined

  return getEnabledModsJs().reverse().map((js) => {
    const vueHooks = js.vueHooks || []
    var mixin = {
      created() {
        // Normally mixins are ignored on name collision
        // We need to do the opposite of that, so we hook `created`
        vueHooks.forEach((hook) => {
          // Shorthand
          if (hook.matchName) {
            hook.match = (c) => (c.$options.name == hook.matchName)
          }

          if (hook.match(this)) {
            for (const cname in (hook.computed || {})) {
              // Precomputed super function
              // eslint-disable-next-line no-extra-parens
              const sup = (() => this._computedWatchers[cname].getter.call(this) || nop);
              Object.defineProperty(this, cname, {
                get: () => (hook.computed[cname](sup)),
                configurable: true
              })
            }
            for (const dname in (hook.data || {})) {
              const value = hook.data[dname]
              this[dname] = (typeof value == "function" ? value(this[dname]) : value)
            }
          }
        })
      }
    }
    return mixin
  })
}

// Runtime
// Grey magic. This file can be run from either process, but only the main process will do file handling.

if (ipcMain) {
  // We are in the main process.
  function loadModChoices(){
    // Get the list of mods players can choose to enable/disable
    var mod_folders
    try {
      // TODO: Replace this with proper file globbing
      const tree = crawlFileTree(modsDir, false)
      // .js file or folder of some sort
      mod_folders = Object.keys(tree).filter(p => /\.js$/.test(p) || tree[p] === undefined || logger.warn("Not a mod:", p, tree[p]))
    } catch (e) {
      // No mod folder at all. That's okay.
      logger.error(e)
      return []
    }
    // logger.info("Mod folders seen")
    // logger.debug(mod_folders)

    var items = mod_folders.reduce((acc, dir) => {
      try {
        const js = getModJs(dir)
        acc[dir] = {
          label: js.title,
          desc: js.desc,
          key: dir
        }
      } catch (e) {
        // Catch import-time mod-level errors
        logger.error(e)
      }
      return acc
    }, {})

    logger.info("Mod choices loaded")
    logger.debug(Object.keys(items))
    return items
  }

  modChoices = loadModChoices()

  ipcMain.on('GET_AVAILABLE_MODS', (e) => {e.returnValue = modChoices})
  ipcMain.on('MODS_FORCE_RELOAD', (e) => {
    loadModChoices()
    e.returnValue = true
  })
} else {
  // We are in the renderer process.
  logger.info("Requesting modlist from main")
  modChoices = ipcRenderer.sendSync('GET_AVAILABLE_MODS')
}

export default {
  getEnabledModsJs,  // probably shouldn't use
  getEnabledMods,
  getMixins,
  getMainMixin,
  editArchive,
  bakeRoutes,
  getAssetRoute,

  modChoices
}
