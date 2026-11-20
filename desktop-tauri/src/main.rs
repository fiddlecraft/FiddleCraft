// FiddleCraft desktop: opens the 3D workspace (../dist) in its own window, fully offline.
// The workspace itself is unchanged web code; this file is only the desktop shell around it:
// window, menus, saving files, the "save before closing?" prompt and opening design files.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{IsMenuItem, Menu, MenuBuilder, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_opener::OpenerExt;

const SHELL_JS: &str = include_str!("shell.js");
const SELFTEST_JS: &str = include_str!("selftest.js");

#[derive(Default)]
struct Shell {
    next_window: AtomicUsize,
    /// design files waiting to open once their window's page has loaded
    pending_designs: Mutex<HashMap<String, PathBuf>>,
    /// windows whose page answered a close request (so they are not force-closed)
    close_acks: Mutex<HashSet<String>>,
    zoom: Mutex<f64>,
    /// self-test only: answers for the save prompt, and where saved files go
    selftest_answers: Mutex<Vec<u8>>,
    /// macOS: when the app started, so a design double-clicked in Finder opens in the first window
    #[allow(dead_code)]
    started: Mutex<Option<std::time::Instant>>,
    /// windows whose page has finished loading
    #[allow(dead_code)]
    loaded: Mutex<HashSet<String>>,
}

fn selftest_mode() -> Option<String> {
    std::env::var("SHAPEFORGE_SELFTEST").ok().filter(|m| !m.is_empty())
}

/// A design file passed on the command line (for example by double-clicking a .fiddlecraft or older .shapeforge file)
fn design_from_args(args: &[String], cwd: Option<&Path>) -> Option<PathBuf> {
    args.iter().skip(1).find_map(|a| {
        let lower = a.to_lowercase();
        if !(lower.ends_with(".fiddlecraft") || lower.ends_with(".shapeforge")) {
            return None;
        }
        let p = PathBuf::from(a);
        let p = match (p.is_absolute(), cwd) {
            (false, Some(dir)) => dir.join(p),
            _ => p,
        };
        p.is_file().then_some(p)
    })
}

fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "blob" | "data" | "about" => true,
        "http" | "https" => matches!(url.host_str(), Some("tauri.localhost")),
        _ => false,
    }
}

fn open_window<R: Runtime>(app: &AppHandle<R>, design: Option<PathBuf>) -> tauri::Result<WebviewWindow<R>> {
    let shell = app.state::<Shell>();
    let n = shell.next_window.fetch_add(1, Ordering::SeqCst);
    let label = if n == 0 { "main".to_string() } else { format!("window-{n}") };
    if let Some(d) = design {
        shell.pending_designs.lock().unwrap().insert(label.clone(), d);
    }

    // fit the screen it opens on: small screens (720p laptops, the Steam Deck at 1280 × 800) get the whole screen
    let (sw, sh) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let s = m.work_area().size.to_logical::<f64>(m.scale_factor());
            (s.width, s.height)
        })
        .unwrap_or((1920.0, 1080.0));
    let small = sw <= 1366.0 || sh <= 820.0;
    let selftest = selftest_mode();

    let opener = app.clone();
    let opener2 = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("FiddleCraft")
        .inner_size(1280f64.min(sw), 820f64.min(sh))
        .min_inner_size(720f64.min(sw), 520f64.min(sh))
        .maximized(small && selftest.is_none())
        .background_color(tauri::window::Color(0xf9, 0xfa, 0xfb, 0xff))
        .disable_drag_drop_handler() // the workspace takes dropped STL, SVG and picture files itself
        .initialization_script(SHELL_JS)
        // Website links leave the app and open in the normal browser
        .on_navigation(move |url| {
            if is_app_url(url) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https" | "mailto") {
                let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https" | "mailto") {
                let _ = opener2.opener().open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|win, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let shell = win.state::<Shell>();
            shell.loaded.lock().unwrap().insert(win.label().to_string());
            let design = shell.pending_designs.lock().unwrap().remove(win.label());
            if let Some(path) = design {
                match std::fs::read_to_string(&path) {
                    Ok(text) => {
                        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                        let js = format!(
                            "window.dispatchEvent(new CustomEvent(\"shapeforge-open\", {{ detail: {{ text: {}, name: {} }} }}))",
                            serde_json::to_string(&text).unwrap(),
                            serde_json::to_string(&name).unwrap()
                        );
                        let _ = win.eval(js);
                    }
                    Err(e) => {
                        let _ = win.eval(format!("alert({})", serde_json::to_string(&format!("That design couldn't be opened: {e}")).unwrap()));
                    }
                }
            }
            if let Some(mode) = selftest_mode() {
                if mode != "hold" {
                    let _ = win.eval(SELFTEST_JS.replace("__SELFTEST_MODE__", &mode));
                }
            }
        });

    if let Some(mode) = &selftest {
        // the self-test gets its own throwaway profile so it can never touch the person's saved designs
        let dir = std::env::temp_dir().join(format!("fiddlecraft-selftest-{}", std::process::id()));
        builder = builder.data_directory(dir).visible(std::env::var("SHAPEFORGE_SELFTEST_SHOW").is_ok() || mode == "hold");
    }
    builder.build()
}

fn focused_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    let windows = app.webview_windows();
    windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| windows.get("main"))
        .or_else(|| windows.values().next())
        .cloned()
}

// ---------- Commands the workspace page calls ----------

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Save a file through the computer's own Save dialog. Returns the saved path, or None if cancelled.
#[tauri::command]
async fn save_file(window: WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default();
    let name = header("x-name");
    let label = header("x-label");
    let exts: Vec<String> = header("x-exts").split(',').map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).collect();
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => return Err("No file contents were sent".into()),
    };

    let path: Option<PathBuf> = if selftest_mode().is_some() {
        let dir = std::env::temp_dir().join(format!("fiddlecraft-selftest-{}-files", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Some(dir.join(if name.is_empty() { "file".into() } else { name.clone() }))
    } else {
        let ext_refs: Vec<&str> = exts.iter().map(String::as_str).collect();
        let mut dialog = window.dialog().file().set_parent(&window).set_title("Save").set_file_name(&name);
        if !ext_refs.is_empty() {
            dialog = dialog.add_filter(if label.is_empty() { "File" } else { &label }, &ext_refs);
        }
        dialog.blocking_save_file().and_then(|p| p.into_path().ok())
    };
    let Some(mut path) = path else { return Ok(None) };

    // add the file type if they typed a name without it
    let has_ext = path.extension().map(|e| exts.contains(&e.to_string_lossy().to_lowercase())).unwrap_or(false);
    if !has_ext {
        if let Some(first) = exts.first() {
            let mut s = path.into_os_string();
            s.push(format!(".{first}"));
            path = PathBuf::from(s);
        }
    }
    std::fs::write(&path, &data).map_err(|e| format!("That file couldn't be saved: {e}"))?;
    if selftest_mode().is_some() {
        println!("SELFTEST saved {} ({} bytes)", path.file_name().unwrap_or_default().to_string_lossy(), data.len());
    }
    Ok(Some(path.to_string_lossy().to_string()))
}

/// "Save your design?" before a window closes: 0 Save, 1 Don't save, 2 Cancel
#[tauri::command]
async fn ask_save(window: WebviewWindow) -> u8 {
    if selftest_mode().is_some() {
        let shell = window.state::<Shell>();
        let mut answers = shell.selftest_answers.lock().unwrap();
        return if answers.is_empty() { 1 } else { answers.remove(0) };
    }
    let result = window
        .dialog()
        .message(
            "Save changes to your design before closing?\n\nFiddleCraft also keeps your latest design on this computer, but saving makes a .fiddlecraft file you can keep, back up or share.",
        )
        .title("Save your design?")
        .kind(MessageDialogKind::Info)
        .parent(&window)
        .buttons(MessageDialogButtons::YesNoCancelCustom("Save…".into(), "Don't save".into(), "Cancel".into()))
        .blocking_show_with_result();
    match result {
        MessageDialogResult::Yes | MessageDialogResult::Ok => 0,
        MessageDialogResult::No => 1,
        MessageDialogResult::Custom(label) if label == "Save…" => 0,
        MessageDialogResult::Custom(label) if label == "Don't save" => 1,
        _ => 2,
    }
}

#[tauri::command]
fn close_ack(window: WebviewWindow) {
    window.state::<Shell>().close_acks.lock().unwrap().insert(window.label().to_string());
}

#[tauri::command]
fn close_window(window: WebviewWindow) {
    if selftest_mode().as_deref() == Some("close") {
        println!("SELFTEST close | after Don't save, window closed: true");
    }
    let _ = window.destroy();
}

#[tauri::command]
fn selftest_log(text: String) {
    if selftest_mode().is_some() {
        println!("{text}");
    }
}

#[tauri::command]
fn selftest_exit(app: AppHandle, code: i32) {
    if selftest_mode().is_some() {
        if let Some(dir) = std::env::temp_dir().join(format!("fiddlecraft-selftest-{}", std::process::id())).to_str() {
            let _ = std::fs::remove_dir_all(dir);
        }
        let _ = std::fs::remove_dir_all(std::env::temp_dir().join(format!("fiddlecraft-selftest-{}-files", std::process::id())));
        app.exit(code);
    }
}

/// Self-test only: press the window's close button
#[tauri::command]
fn selftest_close(window: WebviewWindow) {
    if selftest_mode().is_some() {
        let _ = window.close();
    }
}

/// Self-test only: keep a picture of the 3D view (SHAPEFORGE_SHOT=/path/picture.png)
#[tauri::command]
fn selftest_shot(request: tauri::ipc::Request<'_>) {
    if let (Some(_), Ok(path), tauri::ipc::InvokeBody::Raw(bytes)) = (selftest_mode(), std::env::var("SHAPEFORGE_SHOT"), request.body()) {
        let _ = std::fs::write(path, bytes);
    }
}

// ---------- Menus ----------
// Menu items call the workspace. Its keyboard shortcuts are handled inside the workspace (so typing
// a "V" in a text box still types a V), so they are shown in the menu but not registered twice.

const MAC: bool = cfg!(target_os = "macos");

fn item<R: Runtime>(app: &AppHandle<R>, id: &str, label: &str, keys: &str) -> tauri::Result<MenuItem<R>> {
    // macOS shows ⌘ where Windows and Linux show Ctrl
    let keys = if MAC { keys.replace("Ctrl+Shift+", "⇧⌘").replace("Ctrl+", "⌘") } else { keys.to_string() };
    let text = if keys.is_empty() { label.to_string() } else { format!("{label}\u{2003}\u{2003}{keys}") };
    MenuItem::with_id(app, id, text, true, None::<&str>)
}

fn real_key<R: Runtime>(app: &AppHandle<R>, id: &str, label: &str, accel: &str) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, label, true, Some(accel))
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let sep = || PredefinedMenuItem::separator(app);
    let file: Submenu<R> = SubmenuBuilder::new(app, "File")
        .item(&item(app, "app:newDesign()", "New design", "")?)
        .item(&item(app, "app:open()", "Open design…", "Ctrl+O")?)
        .item(&item(app, "app:save()", "Save design…", "Ctrl+S")?)
        .item(&item(app, "app:importSTL()", "Import STL model, SVG drawing or picture…", "")?)
        .item(&sep()?)
        .item(&item(app, "app:versions()", "Restore an earlier version…", "")?)
        .item(&item(app, "app:exportSTL()", "Export for 3D printing (STL)…", "")?)
        .item(&item(app, "app:exportSelected()", "Export selected shapes (STL)…", "")?)
        .item(&item(app, "app:exportWindow()", "Export as STL, OBJ, GLB or SVG…", "Ctrl+E")?)
        .item(&sep()?)
        .item(&real_key(app, "new-window", "New window", "CmdOrCtrl+N")?)
        .item(&real_key(app, if MAC { "close-window" } else { "quit" }, if MAC { "Close window" } else { "Quit" }, if MAC { "Cmd+W" } else { "Ctrl+Q" })?)
        .build()?;

    let line_up = SubmenuBuilder::new(app, "Line up")
        .item(&item(app, "app:align('x','min')", "Left edges", "")?)
        .item(&item(app, "app:align('x','mid')", "Centres (left–right)", "")?)
        .item(&item(app, "app:align('x','max')", "Right edges", "")?)
        .item(&item(app, "app:align('y','min')", "Bottoms", "")?)
        .build()?;
    // macOS only delivers ⌘C/⌘V/⌘X/⌘Z/⌘A through the menu, so there they are the computer's own
    // editing items (in a text box they edit the text; the workspace still sees the keys)
    let edit_key = |id: &str, label: &str, keys: &str| -> tauri::Result<tauri::menu::MenuItemKind<R>> {
        if MAC {
            let l = Some(label);
            Ok(match id {
                "edit:undo:undo" => PredefinedMenuItem::undo(app, l)?.kind(),
                "edit:redo:redo" => PredefinedMenuItem::redo(app, l)?.kind(),
                "edit:selectAll:selectAll" => PredefinedMenuItem::select_all(app, l)?.kind(),
                "edit:cut:cut" => PredefinedMenuItem::cut(app, l)?.kind(),
                "edit:copy:copy" => PredefinedMenuItem::copy(app, l)?.kind(),
                _ => PredefinedMenuItem::paste(app, l)?.kind(),
            })
        } else {
            Ok(item(app, id, label, keys)?.kind())
        }
    };
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&edit_key("edit:undo:undo", "Undo", "Ctrl+Z")?)
        .item(&edit_key("edit:redo:redo", "Redo", "Ctrl+Y")?)
        .item(&sep()?)
        .item(&edit_key("edit:selectAll:selectAll", "Select all shapes", "Ctrl+A")?)
        .item(&item(app, "app:hideSelected()", "Hide selected shapes", "Ctrl+H")?)
        .item(&item(app, "app:showAll()", "Show hidden shapes", "Ctrl+Shift+H")?)
        .item(&item(app, "app:visMode()", "Hide and show…", "V")?)
        .item(&item(app, "app:mirror()", "Mirror…", "M")?)
        .item(&item(app, "app:saveToLibrary()", "Save selection to My shapes…", "")?)
        .item(&sep()?)
        .item(&edit_key("edit:cut:cut", "Cut", "Ctrl+X")?)
        .item(&edit_key("edit:copy:copy", "Copy", "Ctrl+C")?)
        .item(&edit_key("edit:paste:paste", "Paste", "Ctrl+V")?)
        .item(&item(app, "app:duplicate()", "Duplicate", "Ctrl+D")?)
        .item(&item(app, "app:remove()", "Delete shape", "Delete")?)
        .item(&sep()?)
        .item(&item(app, "app:group()", "Group", "Ctrl+G")?)
        .item(&item(app, "app:ungroup()", "Ungroup", "Ctrl+Shift+G")?)
        .item(&sep()?)
        .item(&item(app, "app:drop()", "Drop to workplane", "D")?)
        .item(&item(app, "app:alignTool()", "Align tool", "L")?)
        .item(&line_up)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item(app, "app:workplane()", "Workplane size…", "")?)
        .item(&item(app, "app:ruler()", "Ruler", "")?)
        .item(&item(app, "app:planeTool()", "Workplane on a face", "W")?)
        .item(&item(app, "app:resetView()", "Reset view", "H")?)
        .item(&item(app, "app:view('fit')", "Zoom to fit", "F")?)
        .item(&item(app, "app:view('top')", "Top", "1")?)
        .item(&item(app, "app:flatView()", "Flat view on/off", "O")?)
        .item(&item(app, "app:view('front')", "Front", "2")?)
        .item(&item(app, "app:view('side')", "Side", "3")?)
        .item(&sep()?)
        .item(&real_key(app, "fullscreen", "Toggle full screen", if MAC { "Ctrl+Cmd+F" } else { "F11" })?)
        .item(&real_key(app, "zoom-in", "Zoom in", "CmdOrCtrl+=")?)
        .item(&real_key(app, "zoom-out", "Zoom out", "CmdOrCtrl+-")?)
        .item(&real_key(app, "zoom-reset", "Actual size", "CmdOrCtrl+0")?)
        .build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&item(app, "app:welcome()", "Getting started", "")?)
        .item(&item(app, "app:help()", "Keyboard and mouse", "?")?)
        .build()?;

    if MAC {
        // the first menu on a Mac is the app's own menu
        let app_menu = SubmenuBuilder::new(app, "FiddleCraft")
            .item(&PredefinedMenuItem::about(app, Some("About FiddleCraft"), None)?)
            .item(&sep()?)
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .item(&sep()?)
            .item(&real_key(app, "quit", "Quit FiddleCraft", "Cmd+Q")?)
            .build()?;
        let window = SubmenuBuilder::new(app, "Window")
            .item(&PredefinedMenuItem::minimize(app, None)?)
            .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
            .build()?;
        return MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &window, &help]).build();
    }
    MenuBuilder::new(app).items(&[&file, &edit, &view, &help]).build()
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "new-window" => {
            let _ = open_window(app, None);
        }
        "quit" => {
            // each window asks to save its own design first
            for w in app.webview_windows().values() {
                let _ = w.close();
            }
        }
        _ => {
            let Some(win) = focused_window(app) else { return };
            match id {
                "close-window" => {
                    let _ = win.close();
                }
                "fullscreen" => {
                    let full = win.is_fullscreen().unwrap_or(false);
                    let _ = win.set_fullscreen(!full);
                }
                "zoom-in" | "zoom-out" | "zoom-reset" => {
                    let shell = app.state::<Shell>();
                    let mut zoom = shell.zoom.lock().unwrap();
                    *zoom = match id {
                        "zoom-in" => (*zoom + 0.1).min(3.0),
                        "zoom-out" => (*zoom - 0.1).max(0.5),
                        _ => 1.0,
                    };
                    for w in app.webview_windows().values() {
                        let _ = w.set_zoom(*zoom);
                    }
                }
                _ => {
                    if let Some(call) = id.strip_prefix("app:") {
                        let _ = win.eval(format!("window.shapeforgeApp && window.shapeforgeApp.{call}"));
                    } else if let Some(rest) = id.strip_prefix("edit:") {
                        let mut parts = rest.splitn(2, ':');
                        let action = parts.next().unwrap_or_default();
                        let command = parts.next().unwrap_or(action);
                        let _ = win.eval(format!("window.__fiddlecraftNative && window.__fiddlecraftNative.edit('{action}', '{command}')"));
                    }
                }
            }
        }
    }
}

fn main() {
    let selftest = selftest_mode();
    if let Some(mode) = &selftest {
        let secs = if mode == "hold" { 3600 } else { 45 };
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(secs));
            println!("SELFTEST TIMEOUT");
            std::process::exit(2);
        });
    }

    let mut builder = tauri::Builder::default();
    if selftest.is_none() {
        // one copy of the app: opening another design adds a window to it
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            match design_from_args(&argv, Some(Path::new(&cwd))) {
                Some(design) => {
                    let _ = open_window(app, Some(design));
                }
                None => {
                    if let Some(w) = focused_window(app) {
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Shell {
            zoom: Mutex::new(1.0),
            selftest_answers: Mutex::new(if selftest.as_deref() == Some("close") { vec![2, 1] } else { vec![] }),
            ..Default::default()
        })
        .menu(build_menu)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Ask the page whether the design needs saving; it closes the window itself when done
                api.prevent_close();
                let label = window.label().to_string();
                let app = window.app_handle().clone();
                app.state::<Shell>().close_acks.lock().unwrap().remove(&label);
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.eval("window.__fiddlecraftNative ? window.__fiddlecraftNative.closeRequested() : window.__TAURI__.core.invoke('close_window')");
                }
                // a page that can't answer (still loading or broken) must not trap the window open
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(3));
                    let answered = app.state::<Shell>().close_acks.lock().unwrap().contains(&label);
                    if !answered {
                        if let Some(w) = app.get_webview_window(&label) {
                            let _ = w.destroy();
                        }
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            save_file,
            ask_save,
            close_ack,
            close_window,
            selftest_log,
            selftest_exit,
            selftest_close,
            selftest_shot
        ])
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            // an AppImage starts inside itself; OWD is the folder it was started from
            let cwd = std::env::var_os("OWD").map(PathBuf::from).or_else(|| std::env::current_dir().ok());
            *app.state::<Shell>().started.lock().unwrap() = Some(std::time::Instant::now());
            open_window(app.handle(), design_from_args(&args, cwd.as_deref()))?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("FiddleCraft could not start")
        .run(|_app, _event| {
            // macOS hands over designs double-clicked in Finder with an event instead of the command line
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &_event {
                for path in urls.iter().filter_map(|u| u.to_file_path().ok()) {
                    let name = path.to_string_lossy().to_lowercase();
                    if !(name.ends_with(".fiddlecraft") || name.ends_with(".shapeforge")) {
                        continue;
                    }
                    let shell = _app.state::<Shell>();
                    let just_started = shell.started.lock().unwrap().map(|t| t.elapsed() < Duration::from_secs(5)).unwrap_or(false);
                    let first_still_loading = _app.get_webview_window("main").is_some() && !shell.loaded.lock().unwrap().contains("main");
                    if just_started && first_still_loading {
                        // the first window opens the design when its page has loaded
                        shell.pending_designs.lock().unwrap().insert("main".into(), path);
                    } else {
                        let _ = open_window(_app, Some(path));
                    }
                }
            }
        });
}
