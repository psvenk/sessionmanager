const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;

// import modules
Cu.import("resource://sessionmanager/modules/logger.jsm");
Cu.import("resource://sessionmanager/modules/preference_manager.jsm");
Cu.import("resource://sessionmanager/modules/password_manager.jsm");

// Get lazy getter functions from XPCOMUtils or define them if they don't exist (only defined in Firefox 3.6 and up)
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
if (typeof XPCOMUtils.defineLazyGetter == "undefined") {
	XPCOMUtils.defineLazyGetter = function XPCU_defineLazyGetter(aObject, aName, aLambda)
	{
		aObject.__defineGetter__(aName, function() {
			delete aObject[aName];
			return aObject[aName] = aLambda.apply(aObject);
		});
	}
}
if (typeof XPCOMUtils.defineLazyServiceGetter == "undefined") {
	XPCOMUtils.defineLazyServiceGetter = function XPCU_defineLazyServiceGetter(aObject, aName, aContract, aInterfaceName)
	{
		this.defineLazyGetter(aObject, aName, function XPCU_serviceLambda() {
			return Cc[aContract].getService(Ci[aInterfaceName]);
		});
	}
}

// NetUtil only exists in Firefox 3.6 and above
__defineGetter__("NetUtil", function() {
	delete this.NetUtil;
	try {
		Cu.import("resource://gre/modules/NetUtil.jsm");
		return NetUtil;
	} catch(ex) {}
});

//
// Constants
//
const SESSION_EXT = ".session";
const BACKUP_SESSION_REGEXP = /^backup(-[1-9](\d)*)?\.session$/;
const AUTO_SAVE_SESSION_NAME = "autosave.session";
const SESSION_REGEXP = /^\[SessionManager v2\]\nname=(.*)\ntimestamp=(\d+)\nautosave=(false|session\/?\d*|window\/?\d*)\tcount=([1-9][0-9]*)\/([1-9][0-9]*)(\tgroup=([^\t\n\r]+))?(\tscreensize=(\d+)x(\d+))?/m;
const CLOSED_WINDOW_FILE = "sessionmanager.dat";
const BACKUP_SESSION_FILENAME = "backup.session";
const FIRST_URL = "http://sessionmanager.mozdev.org/history.html";
const FIRST_URL_DEV = "http://sessionmanager.mozdev.org/changelog.xhtml";
const STARTUP_PROMPT = -11;
const STARTUP_LOAD = -12;

const INVALID_FILENAMES = ["CON", "PRN", "AUX", "CLOCK$", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4",
						   "COM5", "COM6", "COM7", "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4",
						   "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];

// Observers to register for once.
const OBSERVING = ["browser:purge-session-history", "quit-application-requested", "quit-application-granted", "quit-application"];

// Observers to register for per window.  WIN_OBSERVING2 is for notifications that won't be removed for the last window closed
const WIN_OBSERVING = ["sessionmanager:update-undo-button", "sessionmanager:updatetitlebar", "sessionmanager:initial-windows-restored",
                       "sessionmanager:save-tab-tree-change", "sessionmanager:close-windowsession", "sessionmanager:nsPref:changed", 
					   "browser:purge-session-history", "private-browsing"];
const WIN_OBSERVING2 = ["sessionmanager:process-closed-window", "quit-application-granted"];

// Get lazy references to services that will always exist, save a pointer to them so they are available during shut down.
XPCOMUtils.defineLazyServiceGetter(this, "OBSERVER_SERVICE", "@mozilla.org/observer-service;1", "nsIObserverService");
XPCOMUtils.defineLazyServiceGetter(this, "WINDOW_MEDIATOR_SERVICE", "@mozilla.org/appshell/window-mediator;1", "nsIWindowMediator");
XPCOMUtils.defineLazyServiceGetter(this, "PROMPT_SERVICE", "@mozilla.org/embedcomp/prompt-service;1", "nsIPromptService");
XPCOMUtils.defineLazyServiceGetter(this, "IO_SERVICE", "@mozilla.org/network/io-service;1", "nsIIOService");
XPCOMUtils.defineLazyServiceGetter(this, "SECRET_DECODER_RING_SERVICE", "@mozilla.org/security/sdr;1", "nsISecretDecoderRing");
XPCOMUtils.defineLazyServiceGetter(this, "NATIVE_JSON", "@mozilla.org/dom/json;1", "nsIJSON");
XPCOMUtils.defineLazyServiceGetter(this, "VERSION_COMPARE_SERVICE", "@mozilla.org/xpcom/version-comparator;1", "nsIVersionComparator");
XPCOMUtils.defineLazyServiceGetter(this, "SCREEN_MANAGER", "@mozilla.org/gfx/screenmanager;1", "nsIScreenManager");
if (Cc["@mozilla.org/fuel/application;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "Application", "@mozilla.org/fuel/application;1", "fuelIApplication");
}
else if (Cc["@mozilla.org/smile/application;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "Application", "@mozilla.org/smile/application;1", "smileIApplication");
}
if (Cc["@mozilla.org/privatebrowsing;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "PrivateBrowsing", "@mozilla.org/privatebrowsing;1", "nsIPrivateBrowsingService");
}
else PrivateBrowsing = null;
XPCOMUtils.defineLazyGetter(this, "SM_BUNDLE", function() { return Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService).createBundle("chrome://sessionmanager/locale/sessionmanager.properties"); });

// EOL Character - dependent on operating system.
var os = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULRuntime).OS;
var _EOL = /win|os[\/_]?2/i.test(os)?"\r\n":/mac|darwin/i.test(os)?"\r":"\n";
delete os;

// Other services that may or may not exist, but will be set later
var SessionStore = null;
var SessionStartup = null;

var EXPORTED_SYMBOLS = ["gSessionManager", "BACKUP_SESSION_FILENAME", "SESSION_REGEXP", "STARTUP_LOAD", "STARTUP_PROMPT", 
                        "WIN_OBSERVING", "WIN_OBSERVING2", "IO_SERVICE", "OBSERVER_SERVICE", "PROMPT_SERVICE", 
						"SECRET_DECODER_RING_SERVICE", "SessionStore", "WINDOW_MEDIATOR_SERVICE", "VERSION_COMPARE_SERVICE"];

// Reference to main thread for putting up alerts when not in main thread
var mainAlertThread = function(aText) {
  this.text = aText;
};
mainAlertThread.prototype = {
	run: function() {
		PROMPT_SERVICE.alert(gSessionManager.getMostRecentWindow(), gSessionManager.mTitle, this.text);
	},
	QueryInterface: function(iid) {
		if (iid.equals(Ci.nsIRunnable) || iid.equals(Ci.nsISupports)) {
			return this;
		}
		throw Cr.NS_ERROR_NO_INTERFACE;
	}
};
						
// This function procseses read session file, it is here because it can be called as a callback function and I 
// don't want it called directly from outside this module
function getCountString(aCount) { 
	return "\tcount=" + aCount.windows + "/" + aCount.tabs + "\n"; 
};

function processReadSessionFile(state, aFile, headerOnly, aSyncCallback) {
	// old crashrecovery file format
	if ((/\n\[Window1\]\n/.test(state)) && 
		(/^\[SessionManager\]\n(?:name=(.*)\n)?(?:timestamp=(\d+))?/m.test(state))) 
	{
		// read entire file if only read header
		let name = RegExp.$1 || gSessionManager._string("untitled_window");
		let timestamp = parseInt(RegExp.$2) || aFile.lastModifiedTime;
		if (headerOnly) state = gSessionManager.readFile(aFile);
		headerOnly = false;
		state = state.substring(state.indexOf("[Window1]\n"), state.length);
		state = gSessionManager.JSON_encode(gSessionManager.decodeOldFormat(state, true));
		let countString = getCountString(gSessionManager.getCount(state));
		state = "[SessionManager v2]\nname=" + name + "\ntimestamp=" + timestamp + "\nautosave=false" + countString + state;
		gSessionManager.writeFile(aFile, state);
	}
	// Not latest session format
	else if ((/^\[SessionManager( v2)?\]\nname=.*\ntimestamp=\d+\n/m.test(state)) && (!SESSION_REGEXP.test(state)))
	{
		// This should always match, but is required to get the RegExp values set correctly.
		// matchArray[0] - Entire 4 line header
		// matchArray[1] - Top 3 lines (includes name and timestamp)
		// matchArray[2] - " v2" (if it exists) - if missing file is in old format
		// matchArray[3] - Autosave string (if it exists)
		// matchArray[4] - Autosave value (not really used at the moment)
		// matchArray[5] - Count string (if it exists)
		// matchArray[6] - Group string and any invalid count string before (if either exists)
		// matchArray[7] - Invalid count string (if it exists)
		// matchArray[8] - Group string (if it exists)
		// matchArray[9] - Screen size string and, if no group string, any invalid count string before (if either exists)
		// matchArray[10] - Invalid count string (if it exists)
		// matchArray[11] - Screen size string (if it exists)
		let matchArray = /(^\[SessionManager( v2)?\]\nname=.*\ntimestamp=\d+\n)(autosave=(false|true|session\/?\d*|window\/?\d*)[\n]?)?(\tcount=[1-9][0-9]*\/[1-9][0-9]*[\n]?)?((\t.*)?(\tgroup=[^\t\n\r]+[\n]?))?((\t.*)?(\tscreensize=\d+x\d+[\n]?))?/m.exec(state)
		if (matchArray)
		{	
			// If two autosave lines, session file is bad so try and fix it (shouldn't happen anymore)
			let goodSession = !/autosave=(false|true|session\/?\d*|window\/?\d*).*\nautosave=(false|true|session\/?\d*|window\/?\d*)/m.test(state);
			
			// read entire file if only read header
			if (headerOnly) state = gSessionManager.readFile(aFile);
			headerOnly = false;

			if (goodSession)
			{
				let data = state.split("\n")[((matchArray[3]) ? 4 : 3)];
				let backup_data = data;
				// decrypt if encrypted, do not decode if in old format since old format was not encoded
				data = gSessionManager.decrypt(data, true, !matchArray[2]);
				// If old format test JSON data
				if (!matchArray[2]) {
					matchArray[1] = matchArray[1].replace(/^\[SessionManager\]/, "[SessionManager v2]");
					let test_decode = gSessionManager.JSON_decode(data, true);
					// if it failed to decode, try to decrypt again using new format
					if (test_decode._JSON_decode_failed) {
						data = gSessionManager.decrypt(backup_data, true);
					}
				}
				backup_data = null;
				if (!data) {
					// master password entered, but still could not be decrypted - either corrupt or saved under different profile
					if (data == false) {
						gSessionManager.moveToCorruptFolder(aFile);
					}
					return null;
				}
				let countString = (matchArray[5]) ? (matchArray[5]) : getCountString(gSessionManager.getCount(data));
				// remove \n from count string if group or screen size is there
				if ((matchArray[8] || matchArray[11]) && (countString[countString.length-1] == "\n")) countString = countString.substring(0, countString.length - 1);
				let autoSaveString = (matchArray[3]) ? (matchArray[3]).split("\n")[0] : "autosave=false";
				if (autoSaveString == "autosave=true") autoSaveString = "autosave=session/";
				state = matchArray[1] + autoSaveString + countString + (matchArray[8] ? matchArray[8] : "") + (matchArray[11] ? matchArray[11] : "") + gSessionManager.decryptEncryptByPreference(data);
				// bad session so rename it so it won't load again - This catches case where window and/or 
				// tab count is zero.  Technically we can load when tab count is 0, but that should never
				// happen so session is probably corrupted anyway so just flag it so.
				if (/(\d\/0)|(0\/\d)/.test(countString)) 
				{
					// If one window and no tabs (blank session), delete file otherwise mark it bad
					if (countString == "\tcount=1/0\n") {
						gSessionManager.delFile(aFile, true);
						return null;
					}
					else {
						gSessionManager.moveToCorruptFolder(aFile);
						return null;
					}
				}
				gSessionManager.writeFile(aFile, state);
			}
			// else bad session format, attempt to recover by removing extra line
			else {
				let newstate = state.split("\n");
				newstate.splice(3,newstate.length - (newstate[newstate.length-1].length ? 5 : 6));
				if (RegExp.$6 == "\tcount=0/0") newstate.splice(3,1);
				state = newstate.join("\n");
				// Simply do a write and recursively proces the session again with the current state until it's correct
				// or marked as invalid.  This handles the issue with asynchronous writes.
				gSessionManager.writeFile(aFile, state);
				state = processReadSessionFile(state, aFile, headerOnly, aSyncCallback) 
			}
		}
	}
	
	// Convert from Firefox 2/3 format to 3.5+ format if running Firefox 3.5 or later since
	// Firefox 4 and later won't read the old format.  Only convert if the user is not running Firefox 3, 
	// but previously ran FF3 (or we don't know what they ran prior to this).  This will only be called when
	// either caching or displaying the session list so just do a asynchronous read to do the conversion since the
	// session contents are not returned in those cases.
	if (gSessionManager.convertFF3Sessions && state) {
		// Do an asynchronous read and then check that to prevent tying up GUI
		gSessionManager.asyncReadFile(aFile, function(aInputStream, aStatusCode) {
			if (Components.isSuccessCode(aStatusCode) && aInputStream.available()) {
				// Read the session file from the stream and process and return it to the callback function
				let is = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
				is.init(aInputStream);
				let state = is.read(aInputStream.available());
				is.close();
				aInputStream.close();
				if ((/,\s?\"(xultab|text|ownerURI|postdata)\"\s?:/m).test(state)) {
					try {
						state = gSessionManager.convertToLatestSessionFormat(aFile, state);
					}
					catch(ex) { 
						logError(ex); 
					}
				}
			}
		});
	}
	
	return state;
}

// This object handles the asynchronous read/writes when changing the encryption status of all session files
var EncryptionChangeHandler = {
	exception: null,
	sessions: null,
	current_filename: null,
	
	changeEncryption: function() {
		this.changeClosedWindowEncryption();
		this.changeSessionEncryption();
	},
	
	changeSessionEncryption: function() {
		// if no sessions, then this is first time run
		if (!this.sessions) {
			this.exception = null;
			this.sessions = gSessionManager.getSessions();
			if (!this.sessions.length) {
				this.sessions = null;
				return;
			}
			log("Encryption change running", "TRACE");
		}
		// Get next session and read it or if no more do end processing
		let session = this.sessions.pop();
		if (session) {
			this.current_filename = session.fileName
			let file = gSessionManager.getSessionDir(this.current_filename);
			//log("Reading " + this.current_filename, "INFO");
			if (file.exists()) {
				try {
					gSessionManager.asyncReadFile(file,  function(aInputStream, aStatusCode) {
						EncryptionChangeHandler.onSessionFileRead(aInputStream, aStatusCode);
						EncryptionChangeHandler.changeSessionEncryption();
					});
				}
				catch(ex) {
					logError(ex);
					this.changeSessionEncryption();
				}
			}
			else {
				this.changeSessionEncryption();
			}
		}
		else {
			//log("All Done wih exception = " + this.exception, "INFO");
			this.sessions = null;
			this.current_filename = null;
			if (this.exception) {
				gSessionManager.cryptError(exception);
				this.exception = null;
			}
			
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:encryption-change", "done");
			log("Encryption change complete", "TRACE");
		}
	},
	
	changeClosedWindowEncryption: function() {
		let exception = null;
		if (!gSessionManager.mUseSSClosedWindowList) {
			let windows = gSessionManager.getClosedWindows_SM();
			let okay = true;
			windows.forEach(function(aWindow) {
				aWindow.state = gSessionManager.decryptEncryptByPreference(aWindow.state, true);
				if (!aWindow.state || (typeof(aWindow.state) != "string")) {
					exception = aWindow.state;
					okay = false;
					return;
				}
			});
			if (okay) {
				gSessionManager.storeClosedWindows_SM(windows);
			}
			if (exception) gSessionManager.cryptError(exception);
		}
	},
	
	onSessionFileRead: function(aInputStream, aStatusCode) 
	{
		// if read okay and is available
		if (Components.isSuccessCode(aStatusCode) && aInputStream.available()) {
			//log("Read " + this.current_filename, "INFO");
			
			// Read the file from the stream
			let is = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
			is.init(aInputStream);
			let state = is.read(aInputStream.available());
			is.close();
			aInputStream.close();

			if (state) 
			{
				state = state.replace(/\r\n?/g, "\n");
				if (SESSION_REGEXP.test(state))
				{
					state = state.split("\n")
					state[4] = gSessionManager.decryptEncryptByPreference(state[4], true);
					if (state[4] && (typeof(state[4]) == "string")) {
						state = state.join("\n");
						//log("Writing " + this.current_filename, "INFO");
						let file = gSessionManager.getSessionDir(this.current_filename);
						gSessionManager.writeFile(file, state, function(aResult) {
							// If write successful
							if (Components.isSuccessCode(aResult)) {
								// Update cache with new timestamp so we don't re-read it for no reason
								if (gSessionManager.mSessionCache[this.current_filename]) {
									let file = gSessionManager.getSessionDir(this.current_filename);
									gSessionManager.mSessionCache[this.current_filename].time = file.lastModifiedTime;
								}
							}
						});
					}
					else if (!this.exception) this.exception = state[4];
				}
			}
		}
		else {
			this.exception = new Components.Exception(this.current_filename, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
		}
	}
};

//
// The main exported object
//
var gSessionManager = {
	// private temporary values
	_initialized: false,
	_encrypt_file: null,
	_no_prompt_for_session: false,
	_recovering: null,
	_temp_restore: null,
	_number_of_windows: 0,
	_crash_session_filename: null,
	
	// Used to indicate whether or not saving tab tree needs to be updated
	savingTabTreeVisible: false,
	
	// Timers
	_timer : null,
	
	// Session Prompt Data
	sessionPromptData: null,
	sessionPromptReturnData: null,
	
	// Shared data
	_countWindows: true,
	_displayUpdateMessage: null,
	mActiveWindowSessions: [],
	mAlreadyShutdown: false,
	mAutoPrivacy: false,
	mBackupState: null,
	mPlatformVersion: 0,
	mShutdownPromptResults: -1,
	
	// Temporary holder for profile directory
	mProfileDirectory: null,
	
	// Temporary holder for last closed window's state value
	mClosingWindowState: null,
	
	// Cache
	mSessionCache: {},
	mClosedWindowCache: { timestamp: 0, data: null },
	
	// Flags
	convertFF3Sessions: false,
	
	// Callback used to get extensions in Firefox 4.0 and higher
	getExtensionsCallback: function(extensions) {
		try {
			gSessionManager.checkForUpdate(extensions);
		}
		catch(ex) { logError(ex); }
	},
	
	// Check for updated version and make any required changes
	checkForUpdate: function(extensions) {
		let oldVersion = gPreferenceManager.get("version", "");
		let newVersion = extensions.get("{1280606b-2510-4fe0-97ef-9b5a22eafe30}").version;
		if (oldVersion != newVersion)
		{
			// Fix the closed window data if it's encrypted
			if ((VERSION_COMPARE_SERVICE.compare(oldVersion, "0.6.4.2") < 0) && !this.mUseSSClosedWindowList) {
				// if encryption enabled
				if (this.mPref_encrypt_sessions) {
					let windows = this.getClosedWindows_SM();
					
					// if any closed windows
					if (windows.length) {
						// force a master password prompt so we don't waste time if user cancels it, if user cancels three times 
						// simply delete the stored closed windows
						let count = 4;
						while (--count && !PasswordManager.enterMasterPassword());

						let okay = true;
						let exception = null;
						if (count) {
							windows.forEach(function(aWindow) {
								aWindow.state = this.decrypt(aWindow.state, true, true);
								aWindow.state = this.decryptEncryptByPreference(aWindow.state, true);
								if (!aWindow.state || (typeof(aWindow.state) != "string")) {
									okay = false;
									exception = aWindow.state;
									return;
								}
							}, this);
							if (okay) {
								this.storeClosedWindows_SM(windows);
							}
						}
						else {
							okay = false;
						}
						if (!okay) {
							if (exception) this.cryptError(exception, true);
							// delete closed windows
							this.storeClosedWindows_SM([]);
						}
					}
				}
			}

			// this isn't used anymore
			if (VERSION_COMPARE_SERVICE.compare(oldVersion, "0.6.2.5") < 0) gPreferenceManager.delete("_no_reload");

			// Clean out screenX and screenY persist values from localstore.rdf since we don't persist anymore.
			if (VERSION_COMPARE_SERVICE.compare(oldVersion, "0.6.2.1") < 0) {
				let RDF = Cc["@mozilla.org/rdf/rdf-service;1"].getService(Ci.nsIRDFService);
				let ls = Cc["@mozilla.org/rdf/datasource;1?name=local-store"].getService(Ci.nsIRDFDataSource);
				let rdfNode = RDF.GetResource("chrome://sessionmanager/content/options.xul#sessionmanagerOptions");
				let arcOut = ls.ArcLabelsOut(rdfNode);
				while (arcOut.hasMoreElements()) {
					let aLabel = arcOut.getNext();
					if (aLabel instanceof Ci.nsIRDFResource) {
						let aTarget = ls.GetTarget(rdfNode, aLabel, true);
						ls.Unassert(rdfNode, aLabel, aTarget);
					}
				}
				ls.QueryInterface(Ci.nsIRDFRemoteDataSource).Flush();
			}
						
			// Add backup sessions to backup group
			if (VERSION_COMPARE_SERVICE.compare(oldVersion, "0.6.2.8") < 0) {
				let sessions = this.getSessions();
				sessions.forEach(function(aSession) {
					if (aSession.backup) {
						this.group(aSession.fileName, this._string("backup_sessions"));
					}
				}, this);
			}
			
			gPreferenceManager.set("version", newVersion);
			
			// Set flag to display message on update if preference set to true
			if (gPreferenceManager.get("update_message", true)) {
				// If development version, go to development change page
				let dev_version = (/pre\d*/.test(newVersion));
				this._displayUpdateMessage = dev_version ? FIRST_URL_DEV : FIRST_URL;
			}
		}
	},
	
	// This is called from the Session Manager Helper Component.  It would be possible to use the Application event manager to trigger this,
	// but the "ready" event fires after crash processing occurs and the "load" event fires too early.
	initialize: function(extensions)
	{
		log("gSessionManager initialize start", "TRACE");

		// This will force SessionStore to be enabled since Session Manager cannot work without SessionStore being 
		// enabled and presumably anyone installing Session Manager actually wants to use it. 
		// Don't set it unless the preference exists, since this preference no longer exists as of Firefox 3.5.
		if (!Application.prefs.getValue("browser.sessionstore.enabled", true)) {
			Application.prefs.setValue("browser.sessionstore.enabled", true)
		}
		
		// Firefox or SeaMonkey
		let sessionStore = Cc["@mozilla.org/browser/sessionstore;1"] || Cc["@mozilla.org/suite/sessionstore;1"];
		let sessionStart = Cc["@mozilla.org/browser/sessionstartup;1"] || Cc["@mozilla.org/suite/sessionstartup;1"];
		
		if (sessionStore && sessionStart) {
			SessionStore = sessionStore.getService(Ci.nsISessionStore);
			SessionStartup = sessionStart.getService(Ci.nsISessionStartup);
		}
		// Not supported
		else {
			Application.events.addListener("ready", this.onLoad_Uninstall);
			return;
		}
		
		// Determine Mozilla version to see what is supported
		try {
			this.mPlatformVersion = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo).platformVersion;
		} catch (ex) { logError(ex); }
		
		// Set flag indicating last version ran was Firefox 3.0 (prior to Firefox 3.5). Convert sessions if no longer running FF3.
		let FF3 = (VERSION_COMPARE_SERVICE.compare(this.mPlatformVersion,"1.9.1a1pre") < 0);
		this.convertFF3Sessions = gPreferenceManager.get("lastRanFF3", true) && !FF3;
		gPreferenceManager.set("lastRanFF3", FF3);
		
		// Everything is good to go so set initialized to true
		this._initialized = true;

		// Get and save the Profile directory
		this.mProfileDirectory = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfD", Ci.nsIFile);

		this.old_mTitle = this.mTitle = this._string("sessionManager");
		
		this.mPref_allowNamedReplace = gPreferenceManager.get("allowNamedReplace", false);
		this.mPref_append_by_default = gPreferenceManager.get("append_by_default", false);
		this.mPref_autosave_session = gPreferenceManager.get("autosave_session", true);
		this.mPref_backup_on_restart = gPreferenceManager.get("backup_on_restart", false);
		this.mPref_backup_session = gPreferenceManager.get("backup_session", 1);
		this.mPref_click_restore_tab = gPreferenceManager.get("click_restore_tab", true);
		this.mPref_encrypt_sessions = gPreferenceManager.get("encrypt_sessions", false);
		this.mPref_encrypted_only = gPreferenceManager.get("encrypted_only", false);
		this.mPref_hide_tools_menu = gPreferenceManager.get("hide_tools_menu", false);
		this.mPref_max_backup_keep = gPreferenceManager.get("max_backup_keep", 0);
		this.mPref_max_closed_undo = gPreferenceManager.get("max_closed_undo", 10);
		this.mPref_max_display = gPreferenceManager.get("max_display", 20);
		this.mPref_logging = gPreferenceManager.get("logging", false);
		this.mPref_name_format = gPreferenceManager.get("name_format", "%40t-%d");
		this.mPref_overwrite = gPreferenceManager.get("overwrite", false);
		this.mPref_preselect_previous_session = gPreferenceManager.get("preselect_previous_session", false);
		this.mPref_reload = gPreferenceManager.get("reload", false);
		this.mPref_reload_timeout = gPreferenceManager.get("reload_timeout", 60000);
		this.mPref_restore_temporary = gPreferenceManager.get("restore_temporary", false);
		this.mPref_resume_session = gPreferenceManager.get("resume_session", BACKUP_SESSION_FILENAME);
		this.mPref_save_closed_tabs = gPreferenceManager.get("save_closed_tabs", 2);
		this.mPref_save_closed_windows = gPreferenceManager.get("save_closed_windows", 2);
		this.mPref_save_cookies = gPreferenceManager.get("save_cookies", false);
		this.mPref_save_window_list = gPreferenceManager.get("save_window_list", false);
		this.mPref_session_list_order = gPreferenceManager.get("session_list_order", 1);
		this.mPref_session_name_in_titlebar = gPreferenceManager.get("session_name_in_titlebar", 0);
		this.mPref_shutdown_on_last_window_close = gPreferenceManager.get("shutdown_on_last_window_close", false);
		this.mPref_startup = gPreferenceManager.get("startup",0);
		this.mPref_submenus = gPreferenceManager.get("submenus", false);
		
		// split out name and group
		this.getAutoSaveValues(gPreferenceManager.get("_autosave_values", ""));
		gPreferenceManager.observe("", this, false);
		
		// Flag to determine whether or not to use SessionStore Closed Window List (only avaiable in Firefox 3.5 and later)
		this.mUseSSClosedWindowList = gPreferenceManager.get("use_SS_closed_window_list", true) && (typeof(SessionStore.getClosedWindowCount) == "function");
		
		// Make sure resume_session is not null.  This could happen in 0.6.2.  It should no longer occur, but 
		// better safe than sorry.
		if (!this.mPref_resume_session) {
			gPreferenceManager.set("resume_session", BACKUP_SESSION_FILENAME);
			if (this.mPref_startup == 2) gPreferenceManager.set("startup",0);
		}
		
		// Put up saving warning if private browsing mode permanently enabled.
		if (this.isAutoStartPrivateBrowserMode()) {
			if (!gPreferenceManager.get("no_private_browsing_prompt", false)) {
				let dontPrompt = { value: false };
				PROMPT_SERVICE.alertCheck(null, this._string("sessionManager"), this._string("private_browsing_warning"), this._string("prompt_not_again"), dontPrompt);
				if (dontPrompt.value)
				{
					gPreferenceManager.set("no_private_browsing_prompt", true);
				}
			}
		}
		
		// Add observers
		OBSERVING.forEach(function(aTopic) {
			OBSERVER_SERVICE.addObserver(this, aTopic, false);
		}, this);
		
		// Perform any needed update processing here.  For Firefox 4.0 and greater need to use the getExtensions callback
		if (Application.extensions) {
			this.checkForUpdate(Application.extensions);
		} else {
			Application.getExtensions(gSessionManager.getExtensionsCallback);
		}
	
		log("gSessionManager initialize end", "TRACE");
	},
			
/* ........ Listeners / Observers.............. */

	// If SessionStore component does not exist hide Session Manager GUI and uninstall
	onLoad_Uninstall: function()
	{
		log("Uninstalling Because SessionStore does not exist", "INFO");
		Application.events.removeListener("ready", gSessionManager.onLoad_Uninstall);
	
		let title = gSessionManager._string("sessionManager");
		let text = gSessionManager._string("not_supported");
		PROMPT_SERVICE.alert(null, title, text);
		let liExtensionManager = Cc["@mozilla.org/extensions/manager;1"].getService(Ci.nsIExtensionManager);
		liExtensionManager.uninstallItem("{1280606b-2510-4fe0-97ef-9b5a22eafe30}");
		log("Uninstalling Because SessionStore does not exist - done", "INFO");
	},
	
	observe: function(aSubject, aTopic, aData)
	{
		log("gSessionManager.observe: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
		switch (aTopic)
		{
		case "browser:purge-session-history":
			this.clearUndoData("all");
			break;
		case "nsPref:changed":
			this["mPref_" + aData] = gPreferenceManager.get(aData);
			
			switch (aData)
			{
			case "encrypt_sessions":
				this.encryptionChange();
				break;
			case "max_closed_undo":
				if (!this.mUseSSClosedWindowList) {
					if (this.mPref_max_closed_undo == 0)
					{
						this.clearUndoData("window", true);
						OBSERVER_SERVICE.notifyObservers(aSubject, "sessionmanager:nsPref:changed", aData);
					}
					else
					{
						let closedWindows = this.getClosedWindows_SM();
						if (closedWindows.length > this.mPref_max_closed_undo)
						{
							this.storeClosedWindows_SM(closedWindows.slice(0, this.mPref_max_closed_undo));
						}
					}
				}
				break;
			case "_autosave_values":
				// split out name and group
				this.getAutoSaveValues(this.mPref__autosave_values);
				this.mPref__autosave_values = null;
				this.checkTimer();
				OBSERVER_SERVICE.notifyObservers(aSubject, "sessionmanager:nsPref:changed", aData);
				break;
			case "use_SS_closed_window_list":
				// Flag to determine whether or not to use SessionStore Closed Window List
				this.mUseSSClosedWindowList = (this.mPref_use_SS_closed_window_list && 
				                               typeof(SessionStore.getClosedWindowCount) == "function");
				OBSERVER_SERVICE.notifyObservers(aSubject, "sessionmanager:nsPref:changed", aData);
				break;
			case "click_restore_tab":
			case "hide_tools_menu":
			case "reload":
			case "session_name_in_titlebar":
				// Use our own preference notification for notifying windows so that the mPref variable will be up to date.
				OBSERVER_SERVICE.notifyObservers(aSubject, "sessionmanager:nsPref:changed", aData);
				break;
			}
			break;
		case "quit-application":
			// remove observers
			OBSERVING.forEach(function(aTopic) {
				OBSERVER_SERVICE.removeObserver(this, aTopic);			
			}, this);
			gPreferenceManager.unobserve("", this);
		
			// Don't shutdown, if we've already done so (only occurs if shutdown on last window close is set)
			if (!this.mAlreadyShutdown) {
				// only run shutdown for one window and if not restarting browser (or on restart is user wants)
				if (this.mPref_backup_on_restart || (aData != "restart"))
				{
					this.shutDown();
				}
				else
				{
					// Save any active auto-save session, but leave it open.
					this.closeSession(false, false, true);
				}
			}
			break;
		case "quit-application-requested":
			this._restart_requested = (aData == "restart");
			break;
		case "quit-application-granted":
			// quit granted so stop listening for closed windows
			this._stopping = true;
			this._mUserDirectory = this.getUserDir("sessions");
			break;
		// timer periodic call
		case "timer-callback":
			// save auto-save session if open, but don't close it
			log("Timer callback for session timer", "EXTRA");
			this.closeSession(false, false, true);
			break;
		}
	},

/* ........ Menu Event Handlers .............. */

	init: function(aPopup, aIsToolbar)
	{
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }

		// Get window sepecific items
		let window = aPopup.ownerDocument.defaultView;
		let document = window.document;
		let window_session_name = window.com.morac.gSessionManagerWindowObject.__window_session_name;
	
		let separator = get_("separator");
		let backupSep = get_("backup-separator");
		let startSep = get_("start-separator");
		let closer = get_("closer");
		let closerWindow = get_("closer_window");
		let abandon = get_("abandon");
		let abandonWindow = get_("abandon_window");
		let backupMenu = get_("backup-menu");
				
		for (let item = startSep.nextSibling; item != separator; item = startSep.nextSibling)
		{
			aPopup.removeChild(item);
		}
		
		// The first time this function is run after an item is added or removed from the browser toolbar
		// using the customize feature, the backupMenu.menupopup value is not defined.  This happens once for
		// each menu (tools menu and toolbar button).  Using the backupMenu.firstChild will work around this
		// Firefox bug, even though it technically isn't needed.
		let backupPopup = backupMenu.menupopup || backupMenu.firstChild; 
		while (backupPopup.childNodes.length) backupPopup.removeChild(backupPopup.childNodes[0]);
		
		closer.hidden = abandon.hidden = (this.mPref__autosave_name=="");
		closerWindow.hidden = abandonWindow.hidden = !window_session_name;
		
		get_("autosave-separator").hidden = closer.hidden && closerWindow.hidden && abandon.hidden && abandonWindow.hidden;
		
		// Disable saving in privacy mode
		let inPrivateBrowsing = this.isPrivateBrowserMode();
		this.setDisabled(get_("save"), inPrivateBrowsing);
		this.setDisabled(get_("saveWin"), inPrivateBrowsing);
		
		let sessions = this.getSessions();
		let groupNames = [];
		let groupMenus = {};
		let count = 0;
		let backupCount = 0;
		let user_latest = false;
		let backup_latest = false;
		sessions.forEach(function(aSession, aIx) {
			if (!aSession.backup && !aSession.group && (this.mPref_max_display >= 0) && (count >= this.mPref_max_display)) return;
	
			let key = (aSession.backup || aSession.group)?"":(++count < 10)?count:(count == 10)?"0":"";
			let menuitem = document.createElement("menuitem");
			menuitem.setAttribute("label", ((key)?key + ") ":"") + aSession.name + "   (" + aSession.windows + "/" + aSession.tabs + ")");
			menuitem.setAttribute("tooltiptext", menuitem.getAttribute("label"));
			menuitem.setAttribute("oncommand", 'com.morac.gSessionManager.load(window, "' + aSession.fileName + '", (event.shiftKey && (event.ctrlKey || event.metaKey))?"overwrite":(event.shiftKey)?"newwindow":(event.ctrlKey || event.metaKey)?"append":"");');
			menuitem.setAttribute("onclick", 'if (event.button == 1) { this.parentNode.hidePopup(); com.morac.gSessionManager.load(window, "' + aSession.fileName + '", "newwindow"); }');
			menuitem.setAttribute("contextmenu", "sessionmanager-ContextMenu");
			menuitem.setAttribute("filename", aSession.fileName);
			menuitem.setAttribute("backup-item", aSession.backup);
			menuitem.setAttribute("accesskey", key);
			menuitem.setAttribute("autosave", /^window|session/.exec(aSession.autosave));
			menuitem.setAttribute("disabled", this.mActiveWindowSessions[aSession.name.trim().toLowerCase()] || false);
			menuitem.setAttribute("crop", "center");
			// only display one latest (even if two have the same timestamp)
			if (!(aSession.backup?backup_latest:user_latest) &&
			    ((aSession.backup?sessions.latestBackUpTime:sessions.latestTime) == aSession.timestamp)) {
				menuitem.setAttribute("latest", true);
				if (aSession.backup) backup_latest = true;
				else user_latest = true;
			}
			if (aSession.name == this.mPref__autosave_name) menuitem.setAttribute("disabled", true);
			if (aSession.backup) {
				backupCount++;
				backupPopup.appendChild(menuitem);
			}
			else {
				if (aSession.group) {
					let groupMenu = groupMenus[aSession.group];
					if (!groupMenu) {
						groupMenu = document.createElement("menu");
						groupMenu.setAttribute("_id", aSession.group);
						groupMenu.setAttribute("label", aSession.group);
						groupMenu.setAttribute("tooltiptext", aSession.group);
						groupMenu.setAttribute("accesskey", aSession.group.charAt(0));
						groupMenu.setAttribute("contextmenu", "sessionmanager-groupContextMenu");
						let groupPopup = document.createElement("menupopup");
						groupPopup.setAttribute("onpopupshowing", "event.stopPropagation();");
						groupMenu.appendChild(groupPopup);
						
						groupNames.push(aSession.group);
						groupMenus[aSession.group] = groupMenu;
					}
					let groupPopup = groupMenu.menupopup || groupMenu.lastChild; 
					groupPopup.appendChild(menuitem);
				}
				else aPopup.insertBefore(menuitem, separator);
			}
		}, this);
		
		// Display groups in alphabetical order at the top of the list
		if (groupNames.length) {
			groupNames.sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
			let insertBeforeEntry = startSep.nextSibling;
			
			groupNames.forEach(function(aGroup, aIx) {
				aPopup.insertBefore(groupMenus[aGroup], insertBeforeEntry);
			},this);
		}
		
		backupSep.hidden = backupMenu.hidden = (backupCount == 0);
		separator.hidden = (this.mPref_max_display == 0) || ((sessions.length - backupCount) == 0);
		this.setDisabled(get_("load"), separator.hidden && backupSep.hidden);
		this.setDisabled(get_("rename"), separator.hidden && backupSep.hidden);
		this.setDisabled(get_("remove"), separator.hidden && backupSep.hidden);
		this.setDisabled(get_("group"), separator.hidden && backupSep.hidden);
		
		let undoMenu = get_("undo-menu");
		while (aPopup.lastChild != undoMenu)
		{
			aPopup.removeChild(aPopup.lastChild);
		}
		
		let undoDisabled = ((gPreferenceManager.get("browser.sessionstore.max_tabs_undo", 10, true) == 0) &&
		                    ((!this.mUseSSClosedWindowList && (this.mPref_max_closed_undo == 0)) ||
							 (this.mUseSSClosedWindowList && gPreferenceManager.get("browser.sessionstore.max_windows_undo", 10, true) == 0)));
		let divertedMenu = aIsToolbar && document.getElementById("sessionmanager-undo");
		let canUndo = !undoDisabled && !divertedMenu && this.initUndo(undoMenu.firstChild);
		
		undoMenu.hidden = undoDisabled || divertedMenu || !this.mPref_submenus;
		undoMenu.previousSibling.hidden = !canUndo && undoMenu.hidden;
		this.setDisabled(undoMenu, !canUndo);
		
		if (!this.mPref_submenus && canUndo)
		{
			for (item = undoMenu.firstChild.firstChild; item; item = item.nextSibling)
			{
				aPopup.appendChild(item.cloneNode(true));
				
				// Event handlers aren't copied so need to set them up again to display status bar text
				if (item.getAttribute("statustext")) {
					aPopup.lastChild.addEventListener("DOMMenuItemActive", function(event) { this.ownerDocument.getElementById("statusbar-display").setAttribute("label",this.getAttribute("statustext")); }, false);
					aPopup.lastChild.addEventListener("DOMMenuItemInactive",  function(event) { this.ownerDocument.getElementById("statusbar-display").setAttribute("label",''); }, false); 
				}
			}
		}
		
		// Bug copies tooltiptext to children so specifically set tooltiptext for all children
		if (aIsToolbar) {
			this.fixBug374288(aPopup.parentNode);
		}
	},

	// Called from Session Prompt window when not in modal mode
	sessionPromptCallBack: function(aCallbackData) {
		let window = aCallbackData.window__SSi ? this.getWindowBySSI(aCallbackData.window__SSi) : null;
	
		switch(aCallbackData.type) {
			case "save":
				this.save(
					window,
					this.sessionPromptReturnData.sessionName,
					this.sessionPromptReturnData.filename,
					this.sessionPromptReturnData.groupName,
					aCallbackData.oneWindow,
					{ append: this.sessionPromptReturnData.append,
					  autoSave: this.sessionPromptReturnData.autoSave,
					  autoSaveTime: this.sessionPromptReturnData.autoSaveTime,
					  sessionState: this.sessionPromptReturnData.sessionState
					}
				);
				break;
			case "load":
				this.load(
					window,
					this.sessionPromptReturnData.filename, 
					this.sessionPromptReturnData.append ? "newwindow" : (this.sessionPromptReturnData.append_window ? "append" : "overwrite"),
					this.sessionPromptReturnData.sessionState
				);
				break;
			case "group":
				this.group(this.sessionPromptReturnData.filename,this.sessionPromptReturnData.groupName);
				break;
			case "rename":
				this.rename(this.sessionPromptReturnData.filename, this.sessionPromptReturnData.sessionName);
				break;
			case "delete":
				this.remove(this.sessionPromptReturnData.filename, this.sessionPromptReturnData.sessionState);
				break;
		}
	},

	save: function(aWindow, aName, aFileName, aGroup, aOneWindow, aValues)
	{
		// Need a window if saving a window - duh
		if ((!aWindow && aOneWindow) || this.isPrivateBrowserMode()) return;
		
		// Save Window should be modal
		let values = aValues || { text: aWindow ? (this.getFormattedName((aWindow.content.document.title || "about:blank"), new Date()) || (new Date()).toLocaleString()) : "", 
		                          autoSaveable : true, allowNamedReplace : this.mPref_allowNamedReplace, 
								  callbackData: { type: "save", window__SSi: (aWindow ? aWindow.__SSi : null), oneWindow: aOneWindow }};
								  
		if (!aName)
		{
			if (!this.prompt(this._string("save2_session"), this._string("save_" + ((aOneWindow)?"window":"session") + "_ok"), values, this._string("save_" + ((aOneWindow)?"window":"session")), this._string("save_session_ok2")))
			{
				return;
			}
			aName = values.text;
			aFileName = values.name;
			aGroup = values.group;
		}
		if (aName)
		{
			let file = this.getSessionDir(aFileName || this.makeFileName(aName), !aFileName);
			try
			{
				let oldstate = null, merge = false;
				// If appending, get the old state and pass it to getSessionState to merge with the current state
				if (values.append && aFileName && file.exists()) {
					oldstate = this.readSessionFile(file);
					if (oldstate) {
						let matchArray = SESSION_REGEXP.exec(oldstate);
						if (matchArray) {
							oldstate = oldstate.split("\n")[4];
							oldstate = this.decrypt(oldstate);
							if (oldstate) merge = true;
						}
					}
				}
				this.writeFile(file, this.getSessionState(aName, aOneWindow?aWindow:false, this.getNoUndoData(), values.autoSave, aGroup, null, values.autoSaveTime, values.sessionState, oldstate), function(aResults) {
					if (Components.isSuccessCode(aResults)) {
						// Combine auto-save values into string
						let autosaveValues = gSessionManager.mergeAutoSaveValues(aName, aGroup, values.autoSaveTime);
						let refresh = true;
						if (!aOneWindow)
						{
							if (values.autoSave)
							{
								gPreferenceManager.set("_autosave_values", autosaveValues);
							}
							else if (gSessionManager.mPref__autosave_name == aName)
							{
								// If in auto-save session and user saves on top of it as manual turn off autosave
								gPreferenceManager.set("_autosave_values","");
							}
						}
						else 
						{
							if (values.autoSave)
							{
								// Store autosave values into window value and also into window variables
								gSessionManager.getAutoSaveValues(autosaveValues, aWindow);
								refresh = false;
							}
						}
						
						// Update tab tree if it's open (getAutoSaveValues does this as well so don't do it again if already done)
						if (refresh) OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-session-tree", null);
					}
					else {
						let exception = new Components.Exception(aFileName, Cr.NS_ERROR_FILE_ACCESS_DENIED, Components.stack.caller);
						this.ioError(exception);
					}
				});
			}
			catch (ex)
			{
				this.ioError(ex);
			}
		}
	},

	saveWindow: function(aWindow, aName, aFileName, aGroup)
	{
		this.save(aWindow, aName, aFileName, aGroup, true);
	},
	
	// if aOneWindow is true, then close the window session otherwise close the browser session
	closeSession: function(aWindow, aForceSave, aKeepOpen)
	{
		log("closeSession: " + ((aWindow) ? aWindow.com.morac.gSessionManagerWindowObject.__window_session_name : this.mPref__autosave_name) + ", aKeepOpen = " + aKeepOpen, "DATA");
		let name = (aWindow) ? aWindow.com.morac.gSessionManagerWindowObject.__window_session_name : this.mPref__autosave_name;
		let group = (aWindow) ? aWindow.com.morac.gSessionManagerWindowObject.__window_session_group : this.mPref__autosave_group;
		let time = (aWindow) ? aWindow.com.morac.gSessionManagerWindowObject.__window_session_time : this.mPref__autosave_time;
		if (name)
		{
			let file = this.getSessionDir(this.makeFileName(name));
			try
			{
				// If forcing a save or not in private browsing save auto or window session.  Use stored closing window state if it exists.
				if (aForceSave || !this.isPrivateBrowserMode()) this.writeFile(file, this.getSessionState(name, aWindow, this.getNoUndoData(), true, group, null, time, this.mClosingWindowState));
			}
			catch (ex)
			{
				this.ioError(ex);
			}
		
			if (!aKeepOpen) {
				if (!aWindow) {
					gPreferenceManager.set("_autosave_values","");
				}
				else {
					this.getAutoSaveValues(null, aWindow);
				}
			}
			return true;
		}
		return false;
	},
	
	abandonSession: function(aWindow)
	{
		let dontPrompt = { value: false };
		if (gPreferenceManager.get("no_abandon_prompt") || PROMPT_SERVICE.confirmEx(null, this.mTitle, this._string("abandom_prompt"), PROMPT_SERVICE.BUTTON_TITLE_YES * PROMPT_SERVICE.BUTTON_POS_0 + PROMPT_SERVICE.BUTTON_TITLE_NO * PROMPT_SERVICE.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0)
		{
			if (aWindow) {
				this.getAutoSaveValues(null, aWindow);
			}
			else {
				gPreferenceManager.set("_autosave_values","");
			}
			if (dontPrompt.value)
			{
				gPreferenceManager.set("no_abandon_prompt", true);
			}
		}
	},
	
	load: function(aWindow, aFileName, aMode, aSessionState)
	{
		log("load: aFileName = " + aFileName + ", aMode = " + aMode + ", aSessionState = " + !!aSessionState, "DATA");
		let state, window_autosave_values, force_new_window = false, overwrite_window = false, use_new_window = false;
		
		// If no window passed, just grab a recent one.  
		aWindow = aWindow || this.getMostRecentWindow("navigator:browser");

		if (!aFileName) {
			let values = { append_replace: true, callbackData: { type: "load", window__SSi: (aWindow ? aWindow.__SSi : null) } };
			aFileName = this.selectSession(this._string("load_session"), this._string("load_session_ok"), values);
			let file;
			if (!aFileName || !(file = this.getSessionDir(aFileName)) || !file.exists()) return;
			aSessionState = values.sessionState;
			aMode = values.append ? "newwindow" : (values.append_window ? "append" : "overwrite");
		}
		// If loading passed in state date, get session header data from disk, otherwise get entire session
		state = this.readSessionFile(this.getSessionDir(aFileName), !!aSessionState);
		if (!state)
		{
			this.ioError();
			return;
		}

		let matchArray = SESSION_REGEXP.exec(state);
		if (!matchArray)
		{
			this.ioError();
			return;
		}		
		
		// If no passed or recent window, open a new one
		if (!aWindow) {
			aWindow = this.openWindow(gPreferenceManager.get("browser.chromeURL", null, true), "chrome,all,dialog=no");
			use_new_window = true;
		}
		
		// If user somehow managed to load an active Window or Auto Session, ignore it
		if ((/^window/.test(matchArray[3]) && this.mActiveWindowSessions[matchArray[1].trim().toLowerCase()]) ||
		    (/^session/.test(matchArray[3]) && (this.mPref__autosave_name == matchArray[1])))
		{
			log("Opened an already active auto or window session: " + matchArray[1], "INFO");
			return;
		}

		// handle case when always want a new window (even if current window is blank) and
		// want to overwrite the current window, but not the current session
		switch (aMode) {
			case "newwindow_always":
				force_new_window = true;
				aMode = "newwindow";
				break;
			case "overwrite_window":
				overwrite_window = true;
				aMode = "append";			// Basically an append with overwriting tabs
				break;
		}
		
		let sessionWidth = parseInt(matchArray[9]);
		let sessionHeight = parseInt(matchArray[10]);
		let xDelta = (!sessionWidth || isNaN(sessionWidth) || (SCREEN_MANAGER.numberOfScreens > 1)) ? 1 : (aWindow.screen.width / sessionWidth);
		let yDelta = (!sessionHeight || isNaN(sessionHeight) || (SCREEN_MANAGER.numberOfScreens > 1)) ? 1 : (aWindow.screen.height / sessionHeight);
		log("xDelta = " + xDelta + ", yDelta = " + yDelta, "DATA");
			
		state = aSessionState ? aSessionState : state.split("\n")[4];
			
		let startup = (aMode == "startup");
		let newWindow = false;
		let overwriteTabs = true;
		let tabsToMove = null;
		let noUndoData = this.getNoUndoData(true, aMode);

		// gSingleWindowMode is set if Tab Mix Plus's single window mode is enabled
		let browser = this.getMostRecentWindow("navigator:browser");
		let TMP_SingleWindowMode = (browser && typeof(browser.gSingleWindowMode) != "undefined" && browser.gSingleWindowMode);
		if (TMP_SingleWindowMode) log("Tab Mix Plus single window mode is enabled", "INFO");

		// Use only existing window if our preference to do so is set or Tab Mix Plus's single window mode is enabled
		let singleWindowMode = (this.mPref_append_by_default && (aMode != "newwindow")) || TMP_SingleWindowMode;
	
		if (singleWindowMode && (aMode == "newwindow" || (!startup && (aMode != "overwrite") && !this.mPref_overwrite)))
			aMode = "append";
		
		// Use specified mode or default.
		aMode = aMode || "default";
		
		if (startup)
		{
			overwriteTabs = this.isCmdLineEmpty(aWindow);
			tabsToMove = (!overwriteTabs)?Array.slice(aWindow.gBrowser.mTabs):null;
		}
		else if (!overwrite_window && (aMode == "append"))
		{
			overwriteTabs = false;
		}
		else if (!use_new_window && !singleWindowMode && !overwrite_window && (aMode == "newwindow" || (aMode != "overwrite" && !this.mPref_overwrite)))
		{
			// if there is only a blank window with no closed tabs, just use that instead of opening a new window
			let tabs = aWindow.gBrowser;
			if (force_new_window || this.getBrowserWindows().length != 1 || !tabs || tabs.mTabs.length > 1 || 
				tabs.mTabs[0].linkedBrowser.currentURI.spec != "about:blank" || 
				SessionStore.getClosedTabCount(aWindow) > 0) {
				newWindow = true;
			}
		}
		
		// Handle case where trying to restore to a newly opened window and Tab Mix Plus's Single Window Mode is active.
		// TMP is going to close this window after the restore, so restore into existing window
		let altWindow = null;
		if (TMP_SingleWindowMode) {
			let windows = this.getBrowserWindows();
			if (windows.length == 2) {
				log("load: Restoring window into existing window because TMP single window mode active", "INFO");
				if (windows[0] == aWindow) altWindow = windows[1];
				else altWindow = windows[0];
				overwriteTabs = false;
			}
		}

		// Check whether or not to close open auto and window sessions.
		// Don't save current session on startup since there isn't any.  Don't save unless 
		// overwriting existing window(s) since nothing is lost in that case.
		if (!startup && !use_new_window) {
			if ((!newWindow && overwriteTabs) || overwrite_window) {
				// close current window sessions if open
				if (aWindow.com.morac.gSessionManagerWindowObject.__window_session_name) 
				{
					this.closeSession(aWindow);
				}
			}
			if (!newWindow && overwriteTabs && !overwrite_window)
			{
				// Closed all open window sessions
				let abandonBool = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
				abandonBool.data = false;
				OBSERVER_SERVICE.notifyObservers(abandonBool, "sessionmanager:close-windowsession", null);
			
				// close current autosave session if open
				if (this.mPref__autosave_name) 
				{
					this.closeSession(false);
				}
				else 
				{
					if (this.mPref_autosave_session) this.autoSaveCurrentSession();
				}
			}
		}
		
		// If not in private browser mode and did not choose tabs and not appending to current window
		if (!aSessionState && !this.isPrivateBrowserMode() && overwriteTabs && !altWindow)
		{
			// if this is a window session, keep track of it
			if (/^window\/?(\d*)$/.test(matchArray[3])) {
				let time = parseInt(RegExp.$1);
				window_autosave_values = this.mergeAutoSaveValues(matchArray[1], matchArray[7], time);
				log("load: window session", "INFO");
			}
		
			// If this is an autosave session, keep track of it if not opening it in a new window and if there is not already an active session
			if (!newWindow && !overwrite_window && this.mPref__autosave_name=="" && /^session\/?(\d*)$/.test(matchArray[3])) 
			{
				let time = parseInt(RegExp.$1);
				gPreferenceManager.set("_autosave_values", this.mergeAutoSaveValues(matchArray[1], matchArray[7], time));
			}
		}
		
		// If reload tabs enabled and not offline, set the tabs to allow reloading
		if (this.mPref_reload && !IO_SERVICE.offline) {
			try {
				state = this.decrypt(state);
				if (!state) return;
		
				let current_time = new Date();
				current_time = current_time.getTime();
				let tempState = this.JSON_decode(state);
				for (let i in tempState.windows) {
					for (let j in tempState.windows[i].tabs) {
						// Only tag web pages as allowed to reload (this excludes chrome, about, etc)
						if (tempState.windows[i].tabs[j].entries && tempState.windows[i].tabs[j].entries.length != 0 &&
						    /^https?:\/\//.test(tempState.windows[i].tabs[j].entries[tempState.windows[i].tabs[j].index - 1].url)) {
							if (!tempState.windows[i].tabs[j].extData) tempState.windows[i].tabs[j].extData = {};
							tempState.windows[i].tabs[j].extData["session_manager_allow_reload"] = current_time;
							// if last entry isn't loading, need to delay reload to give browser time to load correct history index.
							tempState.windows[i].tabs[j].extData["session_manager_delay_reload"] = (tempState.windows[i].tabs[j].entries.length != tempState.windows[i].tabs[j].index);
						}
					}
				}
				state = this.JSON_encode(tempState);
			}
			catch (ex) { logError(ex); };
		}
		
		// if no browser window open, simply call restoreSession, otherwise do setTimeout.
		if (use_new_window) {
			let okay = gSessionManager.restoreSession(null, state, overwriteTabs, noUndoData, true, (singleWindowMode || (!overwriteTabs && !startup)), startup, window_autosave_values, xDelta, yDelta, aFileName);
			if (!okay) gPreferenceManager.set("_autosave_values", "");
			aWindow.close();
		}
		else {
			aWindow.setTimeout(function() {
				let tabcount = aWindow.gBrowser.mTabs.length;
				let okay = gSessionManager.restoreSession((!newWindow)?(altWindow?altWindow:aWindow):null, state, overwriteTabs, noUndoData, (overwriteTabs && !newWindow && !singleWindowMode && !overwrite_window), 
														  (singleWindowMode || (!overwriteTabs && !startup)), startup, window_autosave_values, xDelta, yDelta, aFileName);
				if (okay) {
					OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-undo-button", null);

					if (tabsToMove)
					{
						let endPos = aWindow.gBrowser.mTabs.length - 1;
						tabsToMove.forEach(function(aTab) { aWindow.gBrowser.moveTabTo(aTab, endPos); });
					}
				}
				// failed to load so clear autosession in case user tried to load one
				else gPreferenceManager.set("_autosave_values", "");
			}, 0);
		}
	},

	rename: function(aSession, aText)
	{
		let values;
		if (aSession && !aText) values = { name: aSession, text: this.mSessionCache[aSession].name };
		else values = {};
		values.callbackData = { type: "rename" };
		
		// if not callback
		if (!aText) {
			if (!this.prompt(this._string("rename_session"), this._string("rename_session_ok"), values, this._string("rename2_session")))
			{
				return;
			}
		}
		else {
			values.name = aSession;
			values.text = aText;
		}
		let file = this.getSessionDir(values.name);
		let filename = this.makeFileName(values.text);
		let newFile = (filename != file.leafName)?this.getSessionDir(filename, true):null;
		
		try
		{
			if (!file || !file.exists()) throw new Error(this._string("file_not_found"));
		
			let state = this.readSessionFile(file);
			let oldname = null;
			// Get original name
			if (/^(\[SessionManager v2\])(?:\nname=(.*))?/m.test(state)) oldname = RegExp.$2;
			// remove group name if it was a backup session
			if (this.mSessionCache[values.name].backup) state = state.replace(/\tgroup=[^\t\n\r]+/m, "");
			this.writeFile(newFile || file, this.nameState(state, values.text));
			if (newFile)
			{
				if (this.mPref_resume_session == file.leafName && this.mPref_resume_session != BACKUP_SESSION_FILENAME &&
					this.mPref_resume_session != AUTO_SAVE_SESSION_NAME)
				{
					gPreferenceManager.set("resume_session", filename);
				}
				this.delFile(file);
			}

			// Update any renamed auto or window session
			this.updateAutoSaveSessions(oldname, values.text);
		}
		catch (ex)
		{
			this.ioError(ex);
		}
	},
	
	group: function(aSession, aNewGroup)
	{
		let values = { multiSelect: true, grouping: true, callbackData: { type: "group" } };
		if (typeof(aNewGroup) == "undefined") {
			aSession = this.prompt(this._string("group_session"), this._string("group_session_okay"), values, this._string("group_session_text"));
		}
		else {
			values.name = aSession;
			values.group = aNewGroup;
		}
		
		if (aSession)
		{
			let auto_save_file_name = this.makeFileName(this.mPref__autosave_name);
			values.name.split("\n").forEach(function(aFileName) {
				try
				{
					let file = this.getSessionDir(aFileName);
					if (!file || !file.exists()) throw new Error(this._string("file_not_found"));
					let state = this.readSessionFile(file);
					state = state.replace(/(\tcount=\d+\/\d+)(\tgroup=[^\t\n\r]+)?/m, function($0, $1) { return $1 + (values.group ? ("\tgroup=" + values.group.replace(/\t/g, " ")) : ""); });
					this.writeFile(file, state);

					// Grouped active session
					if (auto_save_file_name == aFileName)
					{
						gPreferenceManager.set("_autosave_values", this.mergeAutoSaveValues(this.mPref__autosave_name, values.group, this.mPref__autosave_time));
					}
				}
				catch (ex)
				{
					this.ioError(ex);
				}
				
			}, this);
		}
	},

	remove: function(aSession, aSessionState)
	{
		if (!aSession || aSessionState)
		{
			let values = { multiSelect: true, remove: true, callbackData: { type: "delete" } };
			aSession = aSession || this.selectSession(this._string("remove_session"), this._string("remove_session_ok"), values);
			aSessionState = aSessionState || values.sessionState;
			
			// If user chose to delete specific windows and tabs in a session
			if (aSessionState) {
				// Get windows and tabs that were not deleted
				try
				{
					let file = this.getSessionDir(aSession);
					if (file.exists()) {
						let state = this.readSessionFile(file);
						if (state) {
							let matchArray = SESSION_REGEXP.exec(state);
							if (matchArray) {
								state = state.split("\n");
								let count = this.getCount(aSessionState);
								state[3] = state[3].replace(/\tcount=[1-9][0-9]*\/[1-9][0-9]*/, "\tcount=" + count.windows + "/" + count.tabs);
								state[4] = this.decryptEncryptByPreference(aSessionState);
								state = state.join("\n");
								this.writeFile(file, state);
							}
						}
					}
				}
				catch(ex) {
					this.ioError(ex);
				}
				aSessionState = null;
				aSession = null;
			}
		}
		if (aSession)
		{
			aSession.split("\n").forEach(function(aFileName) {
				// If deleted autoload session, revert to no autoload session
				if ((aFileName == this.mPref_resume_session) && (aFileName != BACKUP_SESSION_FILENAME)) {
					gPreferenceManager.set("resume_session", BACKUP_SESSION_FILENAME);
					gPreferenceManager.set("startup", 0);
				}
				// In case deleting an auto-save or window session, update browser data
				this.updateAutoSaveSessions(this.mSessionCache[aFileName].name);
				this.delFile(this.getSessionDir(aFileName));
			}, this);
		}
	},

	openFolder: function()
	{
		let dir = this.getSessionDir();
		try {
			// "Double click" the session directory to open it
			dir.launch();
		} catch (e) {
			try {
				// If launch also fails (probably because it's not implemented), let the
				// OS handler try to open the session directory
				let uri = Cc["@mozilla.org/network/io-service;1"].
				          getService(Ci.nsIIOService).newFileURI(dir);
				let protocolSvc = Cc["@mozilla.org/uriloader/external-protocol-service;1"].
				                  getService(Ci.nsIExternalProtocolService);
				protocolSvc.loadUrl(uri);
			}
			catch (ex)
			{
				this.ioError(ex);
			}
		}
	},

	openOptions: function()
	{
		let dialog = this.getMostRecentWindow("SessionManager:Options");
		if (dialog)
		{
			dialog.focus();
			return;
		}
		
		this.getMostRecentWindow().openDialog("chrome://sessionmanager/content/options.xul", "_blank", "chrome,titlebar,toolbar,centerscreen," + ((gPreferenceManager.get("browser.preferences.instantApply", false, true))?"dialog=no":"modal"));
	},

/* ........ Undo Menu Event Handlers .............. */

	initUndo: function(aPopup, aStandAlone)
	{
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }
		
		// Get window sepecific items
		let window = aPopup.ownerDocument.defaultView;
		let document = window.document;
	
		let separator = get_("closed-separator");
		let label = get_("windows");
		
		for (let item = separator.previousSibling; item != label; item = separator.previousSibling)
		{
			aPopup.removeChild(item);
		}
		
		let defaultIcon = (Application.name.toUpperCase() == "SEAMONKEY") ? "chrome://sessionmanager/skin/bookmark-item.png" :
		                                                            "chrome://sessionmanager/skin/defaultFavicon.png";
		
		let encrypt_okay = true;
		// make sure user enters master password if using sessionmanager.dat
		if (!this.mUseSSClosedWindowList && this.mPref_encrypt_sessions && !PasswordManager.enterMasterPassword()) {
			encrypt_okay = false;
			this.cryptError(this._string("decrypt_fail2"));
		}
		
		let number_closed_windows = 0;
		if (encrypt_okay) {
			let badClosedWindowData = false;
			let closedWindows = this.getClosedWindows();
			closedWindows.forEach(function(aWindow, aIx) {
				// Try to decrypt is using sessionmanager.dat, if can't then data is bad since we checked for master password above
				let state = this.mUseSSClosedWindowList ? aWindow.state : this.decrypt(aWindow.state, true);
				if (!state && !this.mUseSSClosedWindowList) {
					// flag it for removal from the list and go to next entry
					badClosedWindowData = true;
					aWindow._decode_error = "crypt_error";
					return;
				}
				state = this.JSON_decode(state, true);
			
				// detect corrupt sessionmanager.dat file
				if (state._JSON_decode_failed && !this.mUseSSClosedWindowList) {
					// flag it for removal from the list and go to next entry
					badClosedWindowData = true;
					aWindow._decode_error = state._JSON_decode_error;
					return;
				}
			
				// Get favicon
				let image = defaultIcon;
				if (state.windows[0].tabs[0].xultab)
				{
					let xultabData = state.windows[0].tabs[0].xultab.split(" ");
					xultabData.forEach(function(bValue, bIndex) {
						let data = bValue.split("=");
						if (data[0] == "image") {
							image = data[1];
						}
					}, this);
				}
				// Firefox 3.5 uses attributes instead of xultab
				if (state.windows[0].tabs[0].attributes && state.windows[0].tabs[0].attributes.image)
				{
					image = state.windows[0].tabs[0].attributes.image;
				}
				// Trying to display a favicon for an https with an invalid certificate will throw up an exception box, so don't do that
				// Firefox's about:sessionrestore also fails with authentication requests, but Session Manager seems okay with that so just
				// use the work around for https.
				if (/^https:/.test(image)) {
					image = "moz-anno:favicon:" + image;
				}
			
				// Get tab count
				let count = state.windows[0].tabs.length;
		
				let menuitem = document.createElement("menuitem");
				menuitem.setAttribute("class", "menuitem-iconic sessionmanager-closedtab-item");
				menuitem.setAttribute("label", aWindow.name + " (" + count + ")");
				menuitem.setAttribute("tooltiptext", aWindow.name + " (" + count + ")");
				menuitem.setAttribute("index", "window" + aIx);
				menuitem.setAttribute("image", image);
				menuitem.setAttribute("oncommand", 'com.morac.gSessionManager.undoCloseWindow(window, ' + aIx + ', (event.shiftKey && (event.ctrlKey || event.metaKey))?"overwrite":(event.ctrlKey || event.metaKey)?"append":"");');
				menuitem.setAttribute("onclick", 'com.morac.gSessionManager.clickClosedUndoMenuItem(event);');
				menuitem.setAttribute("contextmenu", "sessionmanager-undo-ContextMenu");
				menuitem.setAttribute("crop", "center");
				aPopup.insertBefore(menuitem, separator);
			}, this);
		
			// Remove any bad closed windows
			if (badClosedWindowData)
			{
				let error = null;
				for (let i=0; i < closedWindows.length; i++)
				{
					if (closedWindows[i]._decode_error)
					{
						error = closedWindows[i]._decode_error;
						closedWindows.splice(i, 1);
						this.storeClosedWindows_SM(closedWindows);
						// Do this so we don't skip over the next entry because of splice
						i--;
					}
				}
				if (error == "crypt_error") {
					this.cryptError(this._string("decrypt_fail1"));
				}
				else {
					this.sessionError(error);
				}
			}
			
			number_closed_windows = closedWindows.length;
		}
		
		label.hidden = !encrypt_okay || (number_closed_windows == 0);
		
		let listEnd = get_("end-separator");
		for (item = separator.nextSibling.nextSibling; item != listEnd; item = separator.nextSibling.nextSibling)
		{
			aPopup.removeChild(item);
		}
		
		let closedTabs = SessionStore.getClosedTabData(window);
		let mClosedTabs = [];
		closedTabs = this.JSON_decode(closedTabs);
		closedTabs.forEach(function(aValue, aIndex) {
			mClosedTabs[aIndex] = { title:aValue.title, image:null, 
								url:aValue.state.entries[aValue.state.entries.length - 1].url }
			// Get favicon
			mClosedTabs[aIndex].image = defaultIcon;
			if (aValue.state.xultab)
			{
				let xultabData = aValue.state.xultab.split(" ");
				xultabData.forEach(function(bValue, bIndex) {
					let data = bValue.split("=");
					if (data[0] == "image") {
						mClosedTabs[aIndex].image = data[1];
					}
				}, this);
			}
			// Firefox 3.5 uses attributes instead of xultab
			if (aValue.state.attributes && aValue.state.attributes.image)
			{
				mClosedTabs[aIndex].image = aValue.state.attributes.image;
			}
			// Trying to display a favicon for an https with an invalid certificate will throw up an exception box, so don't do that
			// Firefox's about:sessionrestore also fails with authentication requests, but Session Manager seems okay with that so just
			// use the work around for https.
			if (/^https:/.test(mClosedTabs[aIndex].image)) {
				mClosedTabs[aIndex].image = "moz-anno:favicon:" + mClosedTabs[aIndex].image;
			}
		}, this);

		mClosedTabs.forEach(function(aTab, aIx) {
			let menuitem = document.createElement("menuitem");
			menuitem.setAttribute("class", "menuitem-iconic sessionmanager-closedtab-item");
			menuitem.setAttribute("image", aTab.image);
			menuitem.setAttribute("label", aTab.title);
			menuitem.setAttribute("tooltiptext", aTab.title);
			menuitem.setAttribute("index", "tab" + aIx);
			menuitem.setAttribute("statustext", aTab.url);
			menuitem.addEventListener("DOMMenuItemActive", function(event) { document.getElementById("statusbar-display").setAttribute("label",aTab.url); }, false);
			menuitem.addEventListener("DOMMenuItemInactive",  function(event) { document.getElementById("statusbar-display").setAttribute("label",''); }, false); 
			menuitem.setAttribute("oncommand", 'undoCloseTab(' + aIx + ');');
			menuitem.setAttribute("crop", "center");
			// Removing closed tabs does not work in SeaMonkey 2.0.x or lower so don't give option to do so.
			if ((Application.name.toUpperCase() != "SEAMONKEY") || (VERSION_COMPARE_SERVICE.compare(Application.version, "2.1a1pre") >= 0)) {
				menuitem.setAttribute("onclick", 'com.morac.gSessionManager.clickClosedUndoMenuItem(event);');
				menuitem.setAttribute("contextmenu", "sessionmanager-undo-ContextMenu");
			}
			aPopup.insertBefore(menuitem, listEnd);
		}, this);
		separator.nextSibling.hidden = get_("clear_tabs").hidden = (mClosedTabs.length == 0);
		separator.hidden = get_("clear_windows").hidden = get_("clear_tabs").hidden = separator.nextSibling.hidden || label.hidden;
		
		let showPopup = number_closed_windows + mClosedTabs.length > 0;
		
		if (aStandAlone)
		{
			if (!showPopup)
			{
				window.com.morac.gSessionManagerWindowObject.updateUndoButton(false);
				window.setTimeout(function(aPopup) { aPopup.parentNode.open = false; }, 0, aPopup);
			}
			else {
				// Bug copies tooltiptext to children so specifically set tooltiptext for all children
				this.fixBug374288(aPopup.parentNode);
			}
		}

		return showPopup;
	},

	undoCloseWindow: function(aWindow, aIx, aMode)
	{
		let closedWindows = this.getClosedWindows();
		if (closedWindows[aIx || 0])
		{
			let state = closedWindows.splice(aIx || 0, 1)[0].state;
			
			// gSingleWindowMode is set if Tab Mix Plus's single window mode is active
			if (typeof(gSingleWindowMode) != "undefined" && gSingleWindowMode) aMode = "append";

			if (aMode == "overwrite")
			{
				OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-undo-button", null);
			}
			
			// If using SessionStore closed windows list and doing a normal restore, just use SessionStore API
			if (this.mUseSSClosedWindowList && (aMode != "append") && (aMode != "overwrite")) {
				SessionStore.undoCloseWindow(aIx);
			}
			else {
				let okay = this.restoreSession((aMode == "overwrite" || aMode == "append")?aWindow:null, state, aMode != "append");
				if (okay) {
					this.storeClosedWindows(aWindow, closedWindows, aIx);
					OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-undo-button", null);
				}
			}
		}
	},

	clickClosedUndoMenuItem: function(aEvent) 
	{
		// if ctrl/command right click, remove item from list
		if ((aEvent.button == 2) && (aEvent.ctrlKey || aEvent.metaKey))
		{
			this.removeUndoMenuItem(aEvent.originalTarget);
			aEvent.preventDefault();
			aEvent.stopPropagation();
		}
		let match_array;
		if (aEvent.button == 1 && (match_array = aEvent.originalTarget.getAttribute("index").match(/^tab(\d+)$/)))
		{
			let window = aEvent.originalTarget.ownerDocument.defaultView;
			window.undoCloseTab(match_array[1]);
			this.updateClosedList(aEvent.originalTarget, match_array[1], "tab");
			aEvent.preventDefault();
			aEvent.stopPropagation();
		}
	},
	
	removeUndoMenuItem: function(aTarget)
	{	
		let window = aTarget.ownerDocument.defaultView;
			
		let aIx = null;
		let indexAttribute = aTarget.getAttribute("index");
		// removing window item
		if (indexAttribute.indexOf("window") != -1) {
			// get index
			aIx = indexAttribute.substring(6);
			
			// If Firefox bug 491577 is fixed and using built in closed window list, use SessionStore method.
			if (this.mUseSSClosedWindowList && (typeof(SessionStore.forgetClosedWindow) != "undefined")) {
				SessionStore.forgetClosedWindow(aIx);
				
				// the following forces SessionStore to save the state to disk which the above doesn't do for some reason.
				SessionStore.setWindowValue(window, "SM_dummy_value","1");
				SessionStore.deleteWindowValue(window, "SM_dummy_value");
			}
			else {
				// remove window from closed window list and tell other open windows
				let closedWindows = this.getClosedWindows();
				closedWindows.splice(aIx, 1);
				this.storeClosedWindows(window, closedWindows, aIx);
			}
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-undo-button", "window");

			// update the remaining entries
			this.updateClosedList(aTarget, aIx, "window");
		}
		// removing tab item
		else if (indexAttribute.indexOf("tab") != -1) {
			// get index
			aIx = indexAttribute.substring(3);

			// If Firefox bug 461634 is fixed use SessionStore method.
			if (typeof(SessionStore.forgetClosedTab) != "undefined") {
				SessionStore.forgetClosedTab(window, aIx);
			}
			else {
				// This code is based off of code in Tab Mix Plus
				let state = { windows: [], _firstTabs: true };

				// get closed-tabs from nsSessionStore
				let closedTabs = this.JSON_decode(SessionStore.getClosedTabData(window));
				// purge closed tab at aIndex
				closedTabs.splice(aIx, 1);
				state.windows[0] = { _closedTabs : closedTabs };

				// replace existing _closedTabs
				SessionStore.setWindowState(window, this.JSON_encode(state), false);
			}

			// the following forces SessionStore to save the state to disk which the above doesn't do for some reason.
			SessionStore.setWindowValue(window, "SM_dummy_value","1");
			SessionStore.deleteWindowValue(window, "SM_dummy_value");
			
			// Update toolbar button if no more tabs
			if (SessionStore.getClosedTabCount(window) == 0) 
			{
				OBSERVER_SERVICE.notifyObservers(window, "sessionmanager:update-undo-button", "tab");
			}

			// update the remaining entries
			this.updateClosedList(aTarget, aIx, "tab");
		}
	},
	
	updateClosedList: function(aMenuItem, aIx, aType) 
	{
		// Get menu popup
		let popup = aMenuItem.parentNode;

		// remove item from list
		popup.removeChild(aMenuItem);
					
		// Hide popup if no more tabs, an empty undo popup contains 7 items (see sessionmanager.xul file)
		if (popup.childNodes.length == 7) 
		{
			popup.hidePopup();
		}
		// otherwise adjust indexes
		else 
		{
			for (let i=0; i<popup.childNodes.length; i++)
			{ 
				let index = popup.childNodes[i].getAttribute("index");
				if (index && index.substring(0,aType.length) == aType)
				{
					let indexNo = index.substring(aType.length);
					if (parseInt(indexNo) > parseInt(aIx))
					{
						popup.childNodes[i].setAttribute("index",aType + (parseInt(indexNo) - 1).toString());
					}
				}
			}
		}
	},

	clearUndoList: function(aType)
	{
		let window = this.getMostRecentWindow("navigator:browser");
	
		if (aType != "window") {
			let max_tabs_undo = gPreferenceManager.get("browser.sessionstore.max_tabs_undo", 10, true);
			
			gPreferenceManager.set("browser.sessionstore.max_tabs_undo", 0, true);
			gPreferenceManager.set("browser.sessionstore.max_tabs_undo", max_tabs_undo, true);
			// Check to see if the value was set correctly.  Tab Mix Plus will reset the max_tabs_undo preference 
			// to 10 when changing from 0 to any number.  See http://tmp.garyr.net/forum/viewtopic.php?t=10158
			if (gPreferenceManager.get("browser.sessionstore.max_tabs_undo", 10, true) != max_tabs_undo) {
				gPreferenceManager.set("browser.sessionstore.max_tabs_undo", max_tabs_undo, true);
			}
		}

		if (aType != "tab") {
			if (this.mUseSSClosedWindowList) {
				// use forgetClosedWindow command if available, otherwise use hack
				if (typeof(SessionStore.forgetClosedWindow) != "undefined") {
					while (SessionStore.getClosedWindowCount()) SessionStore.forgetClosedWindow(0);
				}
				else {
					let state = { windows: [ {} ], _closedWindows: [] };
					SessionStore.setWindowState(window, this.JSON_encode(state), false);
				}
			}
			else {
				this.clearUndoData("window");
			}
		}
		
		if (window) {
			// the following forces SessionStore to save the state to disk which isn't done for some reason.
			SessionStore.setWindowValue(window, "SM_dummy_value","1");
			SessionStore.deleteWindowValue(window, "SM_dummy_value");
		}
		
		OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-undo-button", null);
	},
	
/* ........ Right click menu handlers .............. */
	group_popupInit: function(aPopup) {
		let document = aPopup.ownerDocument.defaultView.document;
		let childMenu = document.popupNode.menupopup || document.popupNode.lastChild;
		childMenu.hidePopup();
	},
	
	group_rename: function(aWindow) {
		let filename = aWindow.document.popupNode.getAttribute("filename");
		let parentMenu = aWindow.document.popupNode.parentNode.parentNode;
		let group = filename ? ((parentMenu.id != "sessionmanager-toolbar") ? parentMenu.label : "")
		                     : aWindow.document.popupNode.getAttribute("label");
		let newgroup = { value: group };
		let dummy = {};
		PROMPT_SERVICE.prompt(aWindow, this._string("rename_group"), null, newgroup, null, dummy);
		if (newgroup.value == this._string("backup_sessions")) {
			PROMPT_SERVICE.alert(aWindow, this.mTitle, this._string("rename_fail"));
			return;
		}
		else if (newgroup.value != group) {
			// changing group for one session or multiple sessions?
			if (filename) this.group(filename, newgroup.value);
			else {
				let sessions = this.getSessions();
				sessions.forEach(function(aSession) {
					if (aSession.group == group) {
						this.group(aSession.fileName, newgroup.value);
					}
				}, this);
			}
		}
	},
	
	group_remove: function(aWindow) {
		let group = aWindow.document.popupNode.getAttribute("label");
		if (PROMPT_SERVICE.confirm(aWindow, this.mTitle, this._string("delete_confirm_group"))) {
			
			let sessions = this.getSessions();
			let sessionsToDelete = [];
			sessions.forEach(function(aSession) {
				if (aSession.group == group) {
					sessionsToDelete.push(aSession.fileName);
				}
			}, this);
			if (sessionsToDelete.length) {
				sessionsToDelete = sessionsToDelete.join("\n");
				this.remove(sessionsToDelete);
			}
		}
	},

	session_popupInit: function(aPopup) {
		function get_(a_id) { return aPopup.getElementsByAttribute("_id", a_id)[0] || null; }
		
		let document = aPopup.ownerDocument.defaultView.document;
		
		let current = (document.popupNode.getAttribute("disabled") == "true");
		let autosave = document.popupNode.getAttribute("autosave");
		let replace = get_("replace");
		
		replace.hidden = (this.getBrowserWindows().length == 1);
		
		// Disable saving in privacy mode or loaded auto-save session
		let inPrivateBrowsing = this.isPrivateBrowserMode();
		this.setDisabled(replace, (inPrivateBrowsing | current));
		this.setDisabled(get_("replacew"), (inPrivateBrowsing | current));
		
		// Disable almost everything for currently loaded auto-save session
		this.setDisabled(get_("loadaw"), current);
		this.setDisabled(get_("loada"), current);
		this.setDisabled(get_("loadr"), current);

		// Hide change group choice for backup items		
		get_("changegroup").hidden = (document.popupNode.getAttribute("backup-item") == "true")
		
		// Hide option to close or abandon sessions if they aren't loaded
		get_("closer").hidden = get_("abandon").hidden = !current || (autosave != "session");
		get_("closer_window").hidden = get_("abandon_window").hidden = !current || (autosave != "window");
		get_("close_separator").hidden = get_("closer").hidden && get_("closer_window").hidden;
		
		// Disable setting startup if already startup
		this.setDisabled(get_("startup"), ((this.mPref_startup == 2) && (document.popupNode.getAttribute("filename") == this.mPref_resume_session)));
		
		// If Tab Mix Plus's single window mode is enabled, hide options to load into new windows
		get_("loada").hidden = (typeof(gSingleWindowMode) != "undefined" && gSingleWindowMode);
	},

	session_close: function(aWindow, aOneWindow, aAbandon) {
		if (aOneWindow) {
			let document = aWindow.document;
			let matchArray = /(\d\) )?(.*)   \(\d+\/\d+\)/.exec(document.popupNode.getAttribute("label"))
			if (matchArray && matchArray[2]) {
				let abandonBool = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
				abandonBool.data = (aAbandon == true);
				OBSERVER_SERVICE.notifyObservers(abandonBool, "sessionmanager:close-windowsession", matchArray[2]);
			}
		}
		else {
			if (aAbandon) this.abandonSession();
			else this.closeSession();
		}
	},
	
	session_load: function(aWindow, aReplace, aOneWindow) {
		let document = aWindow.document;
		let session = document.popupNode.getAttribute("filename");
		let oldOverwrite = this.mPref_overwrite;
		this.mPref_overwrite = !!aReplace;
		this.load(aWindow, session, (aReplace?"overwrite":(aOneWindow?"append":"newwindow")));
		this.mPref_overwrite = oldOverwrite;
	},
	
	session_replace: function(aWindow, aOneWindow) {
		let document = aWindow.document;
		let session = document.popupNode.getAttribute("filename");
		let parent = document.popupNode.parentNode.parentNode;
		let group = null;
		if (parent.id.indexOf("sessionmanager-") == -1) {
			group = parent.label;
		}
		if (aOneWindow) {
			this.saveWindow(aWindow, this.mSessionCache[session].name, session, group);
		}
		else {
			this.save(aWindow, this.mSessionCache[session].name, session, group);
		}
	},
	
	session_rename: function(aWindow) {
		let document = aWindow.document;
		let session = document.popupNode.getAttribute("filename");
		this.rename(session);
	},

	session_remove: function(aWindow) {
		let dontPrompt = { value: false };
		let session = aWindow.document.popupNode.getAttribute("filename");
		if (gPreferenceManager.get("no_delete_prompt") || PROMPT_SERVICE.confirmEx(aWindow, this.mTitle, this._string("delete_confirm"), PROMPT_SERVICE.BUTTON_TITLE_YES * PROMPT_SERVICE.BUTTON_POS_0 + PROMPT_SERVICE.BUTTON_TITLE_NO * PROMPT_SERVICE.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0) {
			this.remove(session);
			if (dontPrompt.value) {
				gPreferenceManager.set("no_delete_prompt", true);
			}
		}
	},
	
	session_setStartup: function(aWindow) {
		let document = aWindow.document;
		let session = document.popupNode.getAttribute("filename");
		gPreferenceManager.set("resume_session", session);
		gPreferenceManager.set("startup", 2);
	},
	
/* ........ User Prompts .............. */

	openSessionExplorer: function() {
		this.openWindow(
//			"chrome://sessionmanager/content/sessionexplorer.xul",
			"chrome://sessionmanager/content/places/places.xul",
			"chrome,titlebar,resizable,dialog=yes",
			{},
			this.getMostRecentWindow()
		);
	},
	
	// This will always put up an alert prompt in the main thread
	threadSafeAlert: function(aText) {
		if (Cc["@mozilla.org/thread-manager;1"].getService().isMainThread) {
			PROMPT_SERVICE.alert(this.getMostRecentWindow(), this.mTitle, aText);
		}
		else {
			let mainThread = Cc["@mozilla.org/thread-manager;1"].getService(Ci.nsIThreadManager).mainThread;
			mainThread.dispatch(new mainAlertThread(aText), mainThread.DISPATCH_NORMAL);
		}
	},

	prompt: function(aSessionLabel, aAcceptLabel, aValues, aTextLabel, aAcceptExistingLabel)
	{
		let params = Cc["@mozilla.org/embedcomp/dialogparam;1"].createInstance(Ci.nsIDialogParamBlock);
		aValues = aValues || {};

		// Clear out return data and initialize it
		this.sessionPromptReturnData = null;
		
		this.sessionPromptData = {
			// strings
			acceptExistingLabel: aAcceptExistingLabel || "",
			acceptLabel: aAcceptLabel,
			callbackData: aValues.callbackData || null,
			crashCount: aValues.count || "",
			defaultSessionName: aValues.text || "",
			filename: aValues.name || "",
			sessionLabel: aSessionLabel,
			textLabel: aTextLabel || "",
			// booleans
			addCurrentSession: aValues.addCurrentSession,
			allowNamedReplace: aValues.allowNamedReplace,
			append_replace: aValues.append_replace,
			autoSaveable: aValues.autoSaveable,
			grouping: aValues.grouping,
			ignorable: aValues.ignorable,
			multiSelect: aValues.multiSelect,
			preselect: aValues.preselect,
			remove: aValues.remove,
			selectAll: aValues.selectAll,
			startupPrompt: aValues.startupPrompt,
			// override function
			getSessionsOverride: aValues.getSessionsOverride,
		};

		// Modal if startup or crash prompt or if there's a not a callback function or saving one window
		let window = this.isRunning() ? this.getMostRecentWindow("navigator:browser") : null;
		let modal = !this.isRunning() || !aValues.callbackData || aValues.callbackData.oneWindow;
		
		// Initialize return data if modal.  Don't initialize if not modal because that can result in a memory leak since it might
		// not be cleared
		if (modal) this.sessionPromptReturnData = {};
		
		// Use existing dialog window if not modal
		let dialog = WINDOW_MEDIATOR_SERVICE.getMostRecentWindow("SessionManager:SessionPrompt");
		if (dialog && !modal)
		{
			dialog.focus();
			dialog.com.morac.gSessionManagerSessionPrompt.drawWindow();
			return;
		}
		this.openWindow("chrome://sessionmanager/content/session_prompt.xul", "chrome,titlebar,centerscreen,resizable,dialog=yes" + (modal?",modal":""), 
		                params, window);
						
		if (params.GetInt(0)) {
			aValues.append = this.sessionPromptReturnData.append;
			aValues.append_window = this.sessionPromptReturnData.append_window;
			aValues.autoSave = this.sessionPromptReturnData.autoSave;
			aValues.autoSaveTime = this.sessionPromptReturnData.autoSaveTime;
			aValues.group = this.sessionPromptReturnData.groupName;
			aValues.name = this.sessionPromptReturnData.filename;
			aValues.text = this.sessionPromptReturnData.sessionName;
			aValues.sessionState = this.sessionPromptReturnData.sessionState;
			this.sessionPromptReturnData.sessionState = null;
		}
		aValues.ignore = this.sessionPromptReturnData ? this.sessionPromptReturnData.ignore : null;

		// Clear out return data
		this.sessionPromptReturnData = null;
		
		return params.GetInt(0);
	},
	
	// the aOverride variable in an optional callback procedure that will be used to get the session list instead
	// of the default getSessions() function.  The function must return an array of sessions where a session is an
	// object containing:
	//		name 		- This is what is displayed in the session select window
	//		fileName	- This is what is returned when the object is selected
	//		windows		- Window count (optional - if omited won't display either window or tab count)
	//		tabs		- Tab count	(optional - if omited won't display either window or tab count)
	//		autosave	- Will cause item to be bold (optional)
	//      group       - Group that session is associated with (optional)
	//
	// If the session list is not formatted correctly a message will be displayed in the Error console
	// and the session select window will not be displayed.
	//
	selectSession: function(aSessionLabel, aAcceptLabel, aValues, aOverride)
	{
		let values = aValues || {};
		
		if (aOverride) values.getSessionsOverride = aOverride;
		
		if (this.prompt(aSessionLabel, aAcceptLabel, values))
		{
			return values.name;
		}
		
		return null;
	},
	
	// Put up error prompt
	error: function(aException, aString) {
		if (aException) logError(aException);
	
		this.threadSafeAlert(SM_BUNDLE.formatStringFromName(aString, [(aException)?(aException.message + "\n\n" + aException.location):SM_BUNDLE.GetStringFromName("unknown_error")], 1));
	},

	ioError: function(aException)
	{
		this.error(aException, "io_error");
	},

	sessionError: function(aException)
	{
		this.error(aException, "session_error");
	},

	openWindow: function(aChromeURL, aFeatures, aArgument, aParent)
	{
		if (!aArgument || typeof aArgument == "string")
		{
			let argString = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
			argString.data = aArgument || "";
			aArgument = argString;
		}
		
		return Cc["@mozilla.org/embedcomp/window-watcher;1"].getService(Ci.nsIWindowWatcher).openWindow(aParent || null, aChromeURL, "_blank", aFeatures, aArgument);
	},

	clearUndoListPrompt: function(aType)
	{
		let dontPrompt = { value: false };
		let prompttext = (aType == "tab") ? "clear_tab_list_prompt" : ((aType == "window") ? "clear_window_list_prompt" : "clear_list_prompt");
		if (gPreferenceManager.get("no_clear_" + aType + "list_prompt") || PROMPT_SERVICE.confirmEx(null, this.mTitle, this._string(prompttext), PROMPT_SERVICE.BUTTON_TITLE_YES * PROMPT_SERVICE.BUTTON_POS_0 + PROMPT_SERVICE.BUTTON_TITLE_NO * PROMPT_SERVICE.BUTTON_POS_1, null, null, null, this._string("prompt_not_again"), dontPrompt) == 0)
		{
			this.clearUndoList(aType);
			if (dontPrompt.value)
			{
				gPreferenceManager.set("no_clear_" + aType + "list_prompt", true);
			}
		}
	},
	
/* ........ File Handling .............. */
	convertToSQL: function() {
		// Open SQL file and connect to it
		let file = Cc["@mozilla.org/file/directory_service;1"]
		           .getService(Ci.nsIProperties)
		           .get("ProfD", Ci.nsIFile);
		file.append("sessionmanager.sqlite");
		this.delFile(file, true);

		// delete this after testing
		let date = new Date();
		let begin = date.getTime();
		
		let storageService = Cc["@mozilla.org/storage/service;1"]
		                     .getService(Ci.mozIStorageService);
		let mDBConn = storageService.openDatabase(file); 

		mDBConn.createTable("sessions", "filename TEXT PRIMARY KEY, name TEXT, groupname TEXT, timestamp INTEGER," +
		                     "autosave TEXT, windows INTEGER, tabs INTEGER, backup INTEGER, state BLOB");

		mDBConn.createTable("closed_windows", "id INTEGER PRIMARY KEY, name TEXT, state BLOB");
		
		let sessions = this.getSessions();

		let everythingOkay = true;
		mDBConn.beginTransaction();
		
		sessions.forEach(function(aSession) {
			
			if (everythingOkay) {
				let file = this.getSessionDir(aSession.fileName);
				let state = this.readSessionFile(file);
				if (state) 
				{
					if (SESSION_REGEXP.test(state))
					{
						state = state.split("\n")
					}
				}
				
				if (state[4]) {
					// Just replace whatever's there since the filename is unique
					let statement = mDBConn.createStatement(
						"INSERT INTO sessions (filename, name, groupname, timestamp, autosave, windows, tabs, backup, state) " +
						"VALUES ( :filename, :name, :groupname, :timestamp, :autosave, :windows, :tabs, :backup, :state )"
					);
					// need to wrap in older versions of Firefox
					if (VERSION_COMPARE_SERVICE.compare(this.mPlatformVersion,"1.9.1a1pre") < 0) {
						let wrapper = Cc["@mozilla.org/storage/statement-wrapper;1"]
						              .createInstance(Ci.mozIStorageStatementWrapper);
						wrapper.initialize(statement);
						statement = wrapper;
					}
					statement.params.filename = aSession.fileName;
					statement.params.name = aSession.name;
					statement.params.groupname = aSession.group;
					statement.params.timestamp = aSession.timestamp;
					statement.params.autosave = aSession.autosave;
					statement.params.windows = aSession.windows;
					statement.params.tabs = aSession.tabs;
					statement.params.backup = aSession.backup ? 1 : 0;
					statement.params.state = state[4];
					try {
						statement.execute();
					}
					catch(ex) { 
						everythingOkay = false;
						log("convertToSQL: " + aSession.fileName + " - " + ex, "ERROR", true);
					}
					finally {
						if (VERSION_COMPARE_SERVICE.compare(this.mPlatformVersion,"1.9.1a1pre") < 0) {
							statement.statement.finalize();
						}
						else {
							statement.finalize();
						}
					}
				}
			}
		}, this);

		let closedWindows = this.getClosedWindows_SM();
		closedWindows.forEach(function(aWindow) {
			let statement = mDBConn.createStatement("INSERT INTO closed_windows (name, state) VALUES (:name, :state)");
			// need to wrap in older versions of Firefox
			if (VERSION_COMPARE_SERVICE.compare(this.mPlatformVersion,"1.9.1a1pre") < 0) {
				let wrapper = Cc["@mozilla.org/storage/statement-wrapper;1"]
				              .createInstance(Ci.mozIStorageStatementWrapper);
				statement = wrapper.initialize(statement);
			}
			statement.params.name = aWindow.name;
			statement.params.state = aWindow.state;
			try {
				statement.execute();
			}
			catch(ex) { 
				everythingOkay = false;
				log("convertToSQL" + aWindow.name + " - " + ex, "ERROR", true);
			}
			finally {
				if (VERSION_COMPARE_SERVICE.compare(this.mPlatformVersion,"1.9.1a1pre") < 0) {
					statement.statement.finalize();
				}
				else {
					statement.finalize();
				}
			}
		});
		
		// if everything's good save everything, otherwise undo it
		if (everythingOkay) {
			mDBConn.commitTransaction();
			// delete this after testing
			let date = new Date();
			let end = date.getTime();
			Cu.reportError("Session Manager: Converted to SQL in " + (end - begin) + " ms");
		}
		else {
			mDBConn.rollbackTransaction();
			// delete this after testing
			Cu.reportError("Session Manager: Error converting to SQL");
		}
		mDBConn.close();
	},

	// Used to save window sessions that were open when browser crashed
	saveCrashedWindowSessions: function()
	{
		// Don't save if in private browsing mode
		if (this._crash_session_filename && !this.isPrivateBrowserMode()) {
			let file = this.getSessionDir(this._crash_session_filename);
			if (file) {
				this.readSessionFile(file, false, function(crashed_session) {
					if (crashed_session) {
						crashed_session = gSessionManager.decrypt(crashed_session.split("\n")[4], true);
						if (crashed_session) {
							crashed_session = gSessionManager.JSON_decode(crashed_session, true);
							if (!crashed_session._JSON_decode_failed) {
								// Save each window session found in crashed file
								crashed_session.windows.forEach(function(aWindow) {
									if (aWindow.extData && aWindow.extData._sm_window_session_values) {
										// read window session data and save it and the window into the window session file		
										let window_session_data = aWindow.extData._sm_window_session_values.split("\n");
										gSessionManager.saveWindowSession(window_session_data, aWindow);
									}
								});
							}
						}
					}
				});
			}
		}
	},
	
	saveWindowSession: function(aWindowSessionData, aWindowState)
	{
		log("saveWindowSession: Saving Window Session: " + aWindowSessionData[0] + ", " + aWindowSessionData[1] + ", " + aWindowSessionData[2], "DATA");
		if (aWindowSessionData[0]) {
			let file = this.getSessionDir(this.makeFileName(aWindowSessionData[0]));
			
			try
			{
				let window_session = this.JSON_encode({ windows:[ aWindowState ] });
				this.writeFile(file, this.getSessionState(aWindowSessionData[0], true, this.getNoUndoData(), true, aWindowSessionData[1], null, aWindowSessionData[2], window_session));
			}
			catch (ex)
			{
				this.ioError(ex);
			}
		}
	},
	
	sanitize: function(aPrefName)
	{
		log("sanitize - aPrefName = " + aPrefName, "DATA");
		// If "Clear Recent History" prompt then try to find range, otherwise remove all sessions
		if (aPrefName == "privacy.cpd.extensions-sessionmanager") {
			Cc["@mozilla.org/moz/jssubscript-loader;1"].getService(Ci.mozIJSSubScriptLoader).loadSubScript("chrome://browser/content/sanitize.js");

			let range = Sanitizer.getClearRange();
		   
			// if delete all, then do it.
			if (!range) {
				// Remove all saved sessions
				this.getSessionDir().remove(true);
			}
			else {
				// Delete only sessions after startDate
				let sessions = this.getSessions();
				sessions.forEach(function(aSession, aIx) { 
					if (range[0] <= aSession.timestamp*1000) {
						this.delFile(this.getSessionDir(aSession.fileName));
					}
				}, this);
			}                 
		}
		else {
			// Remove all saved sessions
			this.getSessionDir().remove(true);
		}
	},

	getProfileFile: function(aFileName)
	{
		let file = this.mProfileDirectory.clone();
		file.append(aFileName);
		return file;
	},
	
	getUserDir: function(aFileName)
	{
		let dir = null;
		let dirname = gPreferenceManager.get("sessions_dir", "");
		try {
			if (dirname) {
				dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
				dir.initWithPath(dirname);
				if (dir.isDirectory && dir.isWritable()) {
					dir.append(aFileName);
				}
				else {
					dir = null;
				}
			}
		} catch (ex) {
			// handle the case on shutdown since the above will always throw an exception on shutdown
			if (this._mUserDirectory) dir = this._mUserDirectory.clone();
			else dir = null;
		} finally {
			return dir;
		}
	},

	getSessionDir: function(aFileName, aUnique)
	{
		// Check for absolute path first, session names can't have \ or / in them so this will work.  Relative paths will throw though.
		if (/[\\\/]/.test(aFileName)) {
			let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
			try {
				file.initWithPath(aFileName);
			}
			catch(ex) {
				this.ioError(ex);
				file = null;
			}
			return file;
		}
		else {
			// allow overriding of location of sessions directory
			let dir = this.getUserDir("sessions");
			
			// use default is not specified or not a writable directory
			if (dir == null) {
				dir = this.getProfileFile("sessions");
			}
			if (!dir.exists())
			{
				try {
					dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0700);
				}
				catch (ex) {
					this.ioError(ex);
					return null;
				}
			}
			if (aFileName)
			{
				dir.append(aFileName);
				if (aUnique)
				{
					let postfix = 1, ext = "";
					if (aFileName.slice(-SESSION_EXT.length) == SESSION_EXT)
					{
						aFileName = aFileName.slice(0, -SESSION_EXT.length);
						ext = SESSION_EXT;
					}
					while (dir.exists())
					{
						dir = dir.parent;
						dir.append(aFileName + "-" + (++postfix) + ext);
					}
				}
			}
			return dir.QueryInterface(Ci.nsILocalFile);
		}
	},

	// Cache the session data so menu opens faster, don't want to use async since that reads the entire
	// file in and we don't need to do that.  So simulate it by doing a bunch of short synchronous reads.
	// This reads in one file every 50 ms.  Since it's possible for getSessions() to be called during that
	// time frame, simply stop caching if a session is already cached as that means getSessions() was called.
	cacheSessions: function() {
		let sessionFiles = [];
		let filesEnum = this.getSessionDir().directoryEntries.QueryInterface(Ci.nsISimpleEnumerator);
		while (filesEnum.hasMoreElements())
		{
			let file = filesEnum.getNext().QueryInterface(Ci.nsIFile);
			// don't try to read a directory
			if (file.isDirectory()) continue;
			sessionFiles.push({filename: file.leafName, lastModifiedTime: file.lastModifiedTime});
		}
		let cache_count = sessionFiles.length;
		if (!cache_count) return;
		
		log("gSessionManager:cacheSessions: Caching " + cache_count + " session files.", "INFO");	
		let matchArray, session;
		// timer call back function to cache session data
		var callback = {
			notify: function(timer) {
				//let a = Date.now();
				try {
					session = sessionFiles.pop();
				}
				catch(ex) { 
					logError(ex);
					session = null;
				};
				// if the session is already cached, that means getSession() was called so stop caching sessions
				if (session && !gSessionManager.mSessionCache[session.filename]) {
					if (matchArray = SESSION_REGEXP.exec(gSessionManager.readSessionFile(gSessionManager.getSessionDir(session.filename), true)))
					{
						let timestamp = parseInt(matchArray[2]) || session.lastModifiedTime;
						let backupItem = (BACKUP_SESSION_REGEXP.test(session.filename) || (session.filename == AUTO_SAVE_SESSION_NAME));
						let group = matchArray[7] ? matchArray[7] : "";
						// save mSessionCache data
						gSessionManager.mSessionCache[session.filename] = { name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], time: session.lastModifiedTime, windows: matchArray[4], tabs: matchArray[5], backup: backupItem, group: group };
					}
					//log("gSessionManager:cacheSessions: Cached " + session.filename + " in " + (Date.now() - a) + " milli-seconds.", "INFO");
					timer.initWithCallback(this, 50, Ci.nsITimer.TYPE_ONE_SHOT);
				}
				else {
					gSessionManager.convertFF3Sessions = false;
					log("gSessionManager:cacheSessions: Finished caching.  Cached " + (cache_count - sessionFiles.length) + " session files.", "INFO");
				}
			}
		}
		
		log("gSessionManager.convertFF3Sessions = " + gSessionManager.convertFF3Sessions, "DATA");
		let timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
		timer.initWithCallback(callback, 50, Ci.nsITimer.TYPE_ONE_SHOT);
	},

	//
	// filter - optional regular expression. If specified, will only return sessions that match that expression
	//
	getSessions: function(filter)
	{
		let matchArray;
		let sessions = [];
		sessions.latestTime = sessions.latestBackUpTime = 0;
		
		let filesEnum = this.getSessionDir().directoryEntries.QueryInterface(Ci.nsISimpleEnumerator);
		while (filesEnum.hasMoreElements())
		{
			let file = filesEnum.getNext().QueryInterface(Ci.nsIFile);
			// don't try to read a directory
			if (file.isDirectory()) continue;
			let fileName = file.leafName;
			let backupItem = (BACKUP_SESSION_REGEXP.test(fileName) || (fileName == AUTO_SAVE_SESSION_NAME));
			let cached = this.mSessionCache[fileName] || null;
			if (cached && cached.time == file.lastModifiedTime)
			{
				try {
					if (filter && !filter.test(cached.name)) continue;
				} catch(ex) { 
					log ("getSessions: Bad Regular Expression passed to getSessions, ignoring", true); 
				}
				if (!backupItem && (sessions.latestTime < cached.timestamp)) 
				{
					sessions.latestTime = cached.timestamp;
				}
				else if (backupItem && (sessions.latestBackUpTime < cached.timestamp)) {
					sessions.latestBackUpTime = cached.timestamp;
				}
				sessions.push({ fileName: fileName, name: cached.name, timestamp: cached.timestamp, autosave: cached.autosave, windows: cached.windows, tabs: cached.tabs, backup: backupItem, group: cached.group });
				continue;
			}
			if (matchArray = SESSION_REGEXP.exec(this.readSessionFile(file, true)))
			{
				try {
					if (filter && !filter.test(matchArray[1])) continue;
				} catch(ex) { 
					log ("getSessions: Bad Regular Expression passed to getSessions, ignoring", true); 
				}
				let timestamp = parseInt(matchArray[2]) || file.lastModifiedTime;
				if (!backupItem && (sessions.latestTime < timestamp)) 
				{
					sessions.latestTime = timestamp;
				}
				else if (backupItem && (sessions.latestBackUpTime < timestamp)) {
					sessions.latestBackUpTime = timestamp;
				}
				let group = matchArray[7] ? matchArray[7] : "";
				sessions.push({ fileName: fileName, name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], windows: matchArray[4], tabs: matchArray[5], backup: backupItem, group: group });
				// save mSessionCache data unless browser is shutting down
				if (!this._stopping) this.mSessionCache[fileName] = { name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], time: file.lastModifiedTime, windows: matchArray[4], tabs: matchArray[5], backup: backupItem, group: group };
			}
		}
		
		if (!this.mPref_session_list_order)
		{
			this.mPref_session_list_order = gPreferenceManager.get("session_list_order", 1);
		}
		switch (Math.abs(this.mPref_session_list_order))
		{
		case 1: // alphabetically
			sessions = sessions.sort(function(a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
			break;
		case 2: // chronologically
			sessions = sessions.sort(function(a, b) { return a.timestamp - b.timestamp; });
			break;
		}
		
		return (this.mPref_session_list_order < 0)?sessions.reverse():sessions;
	},

	getClosedWindowsCount: function() {
		return this.getClosedWindows(true);
	},
	
	// Get SessionStore's or Session Manager's Closed window List depending on preference.
	// Return the length if the Length Only parameter is true - only ever true if not using built in closed window list
	getClosedWindows: function(aLengthOnly)
	{
		if (this.mUseSSClosedWindowList) {
			let closedWindows = this.JSON_decode(SessionStore.getClosedWindowData());
			if (aLengthOnly) return closedWindows.length;
			let parts = new Array(closedWindows.length);
			closedWindows.forEach(function(aWindow, aIx) {
				parts[aIx] = { name: aWindow.title, state: this.JSON_encode({windows:[aWindow]}) };
			}, this);
			return parts;
		}
		else {
			return this.getClosedWindows_SM(aLengthOnly);
		}
	},

	getClosedWindows_SM: function(aLengthOnly)
	{
		// Use cached data unless file has changed or was deleted
		let data = null;
		let file = this.getProfileFile(CLOSED_WINDOW_FILE);
		if (!file.exists()) return (aLengthOnly ? 0 : []);
		else if (file.lastModifiedTime > this.mClosedWindowCache.timestamp) {
			data = this.readFile(this.getProfileFile(CLOSED_WINDOW_FILE));
			data = data ? data.split("\n\n") : null;
			this.mClosedWindowCache.data = data;
			this.mClosedWindowCache.timestamp = (data ? file.lastModifiedTime : 0);
			if (aLengthOnly) return (data ? data.length : 0);
		}
		else {
			data = this.mClosedWindowCache.data;
		}
		if (aLengthOnly) {
			return (data ? data.length : 0);
		}
		else {
			return (data)?data.map(function(aEntry) {
				let parts = aEntry.split("\n");
				return { name: parts.shift(), state: parts.join("\n") };
			}):[];
		}
	},

	// Stored closed windows into Session Store or Session Manager controller list.
	storeClosedWindows: function(aWindow, aList, aIx)
	{
		if (this.mUseSSClosedWindowList) {
			// The following works in that the closed window appears to be removed from the list with no side effects
			let closedWindows = this.JSON_decode(SessionStore.getClosedWindowData());
			closedWindows.splice(aIx || 0, 1);
			let state = { windows: [ {} ], _closedWindows: closedWindows };
			SessionStore.setWindowState(aWindow, this.JSON_encode(state), false);
			// the following forces SessionStore to save the state to disk which the above doesn't do for some reason.
			SessionStore.setWindowValue(aWindow, "SM_dummy_value","1");
			SessionStore.deleteWindowValue(aWindow, "SM_dummy_value");
		}
		else {
			this.storeClosedWindows_SM(aList);
		}
	},

	// Store closed windows into Session Manager controlled list
	storeClosedWindows_SM: function(aList)
	{
		let file = this.getProfileFile(CLOSED_WINDOW_FILE);
		if (aList.length > 0)
		{
			let data = aList.map(function(aEntry) {
				return aEntry.name + "\n" + aEntry.state
			});
			try {
				this.writeFile(file, data.join("\n\n"));
				this.mClosedWindowCache.data = data;
				this.mClosedWindowCache.timestamp = (data ? file.lastModifiedTime : 0);
			}
			catch(ex) {
				this.ioError(ex);
				return;
			}
		}
		else
		{
			try {
				this.delFile(file);
				this.mClosedWindowCache.data = null;
				this.mClosedWindowCache.timestamp = 0;
			}
			catch(ex) {
				this.ioError(ex);
				return;
			}
		}
		
		if (Cc["@mozilla.org/thread-manager;1"].getService().isMainThread) {
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-undo-button", null);
		}
	},

	clearUndoData: function(aType, aSilent)
	{
		if (aType == "window" || aType == "all")
		{
			this.delFile(this.getProfileFile(CLOSED_WINDOW_FILE), aSilent);
		}
	},

	shutDown: function()
	{
		log("Shutdown start", "TRACE");
		// Handle sanitizing if sanitize on shutdown without prompting (only Firefox 3.0 and SeaMonkey 2.0 ever prompt)
		let prompt = gPreferenceManager.get("privacy.sanitize.promptOnSanitize", null, true);
		let sanitize = (gPreferenceManager.get("privacy.sanitize.sanitizeOnShutdown", false, true) && 
		               (((prompt == false) && gPreferenceManager.get("privacy.item.extensions-sessionmanager", false, true)) ||
		                ((prompt == null) && gPreferenceManager.get("privacy.clearOnShutdown.extensions-sessionmanager", false, true))));

		if (sanitize)
		{
			this.sanitize();
		}
		// otherwise
		else
		{
			// If preference to clear save windows or using SessionStore closed windows, delete our closed window list
			if (!this.mPref_save_window_list || this.mUseSSClosedWindowList)
			{
				this.clearUndoData("window", true);
			}
			
			// Don't back up if in private browsing mode automatically via privacy preference
			// Allow back up if we started in private browsing mode and preferences are set correctly
			let nobackup = this.mAutoPrivacy && (this.mShutDownInPrivateBrowsingMode || this.isPrivateBrowserMode());
		
			// save the currently opened session (if there is one) otherwise backup if auto-private browsing mode not enabled
			if (!this.closeSession(false) && !nobackup)
			{
				this.backupCurrentSession();
			}
			else
			{
				this.keepOldBackups(false);
			}
			
			this.delFile(this.getSessionDir(AUTO_SAVE_SESSION_NAME), true);
		}
		
		gPreferenceManager.delete("_autosave_values");
		this.mClosingWindowState = null;
		this.mTitle = this.old_mTitle;
		this._screen_width = null;
		this._screen_height = null;

		// Cleanup left over files from Crash Recovery
		if (gPreferenceManager.get("extensions.crashrecovery.resume_session_once", false, true))
		{	
			this.delFile(this.getProfileFile("crashrecovery.dat"), true);
			this.delFile(this.getProfileFile("crashrecovery.bak"), true);
			gPreferenceManager.delete("extensions.crashrecovery.resume_session_once", true);
		}
		this.setRunning(false);
		log("Shutdown end", "TRACE");
	},
	
	autoSaveCurrentSession: function(aForceSave)
	{
		try
		{
			if (aForceSave || !this.isPrivateBrowserMode()) {
				let state = this.getSessionState(this._string("autosave_session"), null, null, null, this._string("backup_sessions"));
				if (!state) return;
				this.writeFile(this.getSessionDir(AUTO_SAVE_SESSION_NAME), state);
			}
		}
		catch (ex)
		{
			this.ioError(ex);
		}
	},

	backupCurrentSession: function(aEnteringPrivateBrowsingMode)
	{
		log("backupCurrentSession start", "TRACE");
		let backup = this.mPref_backup_session;
		let temp_backup = (this.mPref_startup == 2) && (this.mPref_resume_session == BACKUP_SESSION_FILENAME);

		log("backupCurrentSession: backup = " + backup + ", temp_backup = " + temp_backup, "DATA");

		// Get results from prompt in component if it was displayed and set the value back to the default
		let results = this.mShutdownPromptResults;
		log("backupCurrentSession: results = " + results, "DATA");
		if (results != -1) this.mShutdownPromptResults = -1;
		
		// If quit was pressed, skip all the session stuff below
		if (results == 1) backup = -1;
		
		// Don't save if just a blank window, if there's an error parsing data, just save
		let state = null;
		if ((backup > 0) || temp_backup) {
			// If shut down in private browsing mode, use the pre-private sesssion, otherwise get the current one
			let helper_state = (this.mShutDownInPrivateBrowsingMode || this.isPrivateBrowserMode()) ? this.mBackupState : null;
			log("backupCurrentSession: helper_state = " + helper_state, "DATA");
		
			try {
				state = this.getSessionState(this._string("backup_session"), null, this.getNoUndoData(), null, this._string("backup_sessions"), true, null, helper_state);
			} catch(ex) {
				logError(ex);
			}
			try {
				let aState = this.JSON_decode(state.split("\n")[4]);
				log("backupCurrentSession: Number of Windows #1 = " + aState.windows.length + ((aState.windows.length == 1) ? (", Number of Tabs in Window[1] = " + aState.windows[0].tabs.length) : ""), "DATA");
				log(state, "STATE");
				// if window data has been cleared ("Visited Pages" cleared on shutdown), use mClosingWindowState, if it exists.
				if ((aState.windows.length == 0 || (aState.windows.length == 1 && aState.windows[0].tabs.length == 0)) && this.mClosingWindowState) {
					log("backupCurrentSession: Using closing Window State", "INFO");
					state = this.getSessionState(this._string("backup_session"), null, this.getNoUndoData(), null, this._string("backup_sessions"), true, null, this.mClosingWindowState);
					log(state, "STATE");
					aState = this.JSON_decode(state.split("\n")[4]);
				}
				log("backupCurrentSession: Number of Windows #2 = " + aState.windows.length, "DATA");
				if (!((aState.windows.length > 1) || (aState.windows[0]._closedTabs.length > 0) || (aState.windows[0].tabs.length > 1) || 
		    		(aState.windows[0].tabs[0].entries.length > 1) || 
		    		((aState.windows[0].tabs[0].entries.length == 1 && aState.windows[0].tabs[0].entries[0].url != "about:blank")))) {
					backup = 0;
					temp_backup = false;
				}
			} catch(ex) { 
				logError(ex);
			}
		}

		if (backup == 2)
		{
			let dontPrompt = { value: false };
			if (results == -1) {
				let saveRestore = !(gPreferenceManager.get("browser.sessionstore.resume_session_once", false, true) || this.doResumeCurrent() || aEnteringPrivateBrowsingMode);
				let flags = PROMPT_SERVICE.BUTTON_TITLE_SAVE * PROMPT_SERVICE.BUTTON_POS_0 + 
							PROMPT_SERVICE.BUTTON_TITLE_DONT_SAVE * PROMPT_SERVICE.BUTTON_POS_1 + 
							(saveRestore ? (PROMPT_SERVICE.BUTTON_TITLE_IS_STRING * PROMPT_SERVICE.BUTTON_POS_2) : 0); 
				results = PROMPT_SERVICE.confirmEx(null, this.mTitle, this._string("preserve_session"), flags,
			              null, null, this._string("save_and_restore"), this._string("prompt_not_again"), dontPrompt);
			}
			backup = (results == 1)?-1:1;
			if (results == 2) {
				if (dontPrompt.value) {
					gPreferenceManager.set("resume_session", BACKUP_SESSION_FILENAME);
					gPreferenceManager.set("startup", 2);
				}
				else gPreferenceManager.set("restore_temporary", true);
			}
			if (dontPrompt.value)
			{
				gPreferenceManager.set("backup_session", (backup == -1)?0:1);
			}
		}
		if (backup > 0 || temp_backup)
		{
			this.keepOldBackups(backup > 0);
			
			// encrypt state if encryption preference set
			if (this.mPref_encrypt_sessions) {
				state = state.split("\n")
				state[4] = this.decryptEncryptByPreference(state[4]);
				if (!state[4]) return;
				state = state.join("\n");
			}
			
			try
			{
				this.writeFile(this.getSessionDir(BACKUP_SESSION_FILENAME), state);
				if (temp_backup && (backup <= 0)) gPreferenceManager.set("backup_temporary", true);
			}
			catch (ex)
			{
				this.ioError(ex);
			}
		}
		else this.keepOldBackups(false);
		log("backupCurrentSession end", "TRACE");
	},

	keepOldBackups: function(backingUp)
	{
		if (!backingUp && (this.mPref_max_backup_keep > 0)) this.mPref_max_backup_keep = this.mPref_max_backup_keep + 1; 
		let backup = this.getSessionDir(BACKUP_SESSION_FILENAME);
		if (backup.exists() && this.mPref_max_backup_keep)
		{
			let oldBackup = this.getSessionDir(BACKUP_SESSION_FILENAME, true);
			// preserve date that file was backed up
			let date = new Date();
			date.setTime(backup.lastModifiedTime); 
			let name = this.getFormattedName("", date, this._string("old_backup_session"));
			this.writeFile(oldBackup, this.nameState(this.readSessionFile(backup), name));
			this.delFile(backup, true);
		}
		
		if (this.mPref_max_backup_keep != -1)
		{
			this.getSessions().filter(function(aSession) {
				return /^backup-\d+\.session$/.test(aSession.fileName);
			}).sort(function(a, b) {
				return b.timestamp - a.timestamp;
			}).slice(this.mPref_max_backup_keep).forEach(function(aSession) {
				this.delFile(this.getSessionDir(aSession.fileName), true);
			}, this);
		}
	},

	readSessionFile: function(aFile,headerOnly,aSyncCallback)
	{
		// Since there's no way to really actually read only the first few lines in a file with an
		// asynchronous read, we do header only reads synchronously.
		if (typeof aSyncCallback == "function") {
			this.asyncReadFile(aFile, function(aInputStream, aStatusCode) {
				if (Components.isSuccessCode(aStatusCode) && aInputStream.available()) {
					// Read the session file from the stream and process and return it to the callback function
					let is = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
					is.init(aInputStream);
					let state = is.read(headerOnly ? 1024 : aInputStream.available());
					is.close();
					aInputStream.close();
					state = processReadSessionFile(state, aFile, headerOnly, aSyncCallback);
					if (state) aSyncCallback(state);
				}
			});
			return null;
		}
		else {
			let state = this.readFile(aFile,headerOnly);
			return processReadSessionFile(state, aFile, headerOnly);
		}
	},
	
	asyncReadFile: function(aFile, aCallback)
	{
		let fileURI = IO_SERVICE.newFileURI(aFile);
		let channel = IO_SERVICE.newChannelFromURI(fileURI);
		
		// Use NetUtil if it exists (Firefox 3.6 and above) otherwise mostly duplicate code from NetUtil.
		if (typeof NetUtil != "undefined") {
			NetUtil.asyncFetch(channel, aCallback);
		}
		else {
			// Create a pipe that will create our output stream that we can use once
			// we have gotten all the data.
			let pipe = Cc["@mozilla.org/pipe;1"].createInstance(Ci.nsIPipe);
			pipe.init(true, true, 0, 0xffffffff, null);
		
			// Create a listener that will give data to the pipe's output stream.
			let listener = Cc["@mozilla.org/network/simple-stream-listener;1"].createInstance(Ci.nsISimpleStreamListener);
		
			listener.init(pipe.outputStream, {
				onStartRequest: function(aRequest, aContext) {},
				onStopRequest: function(aRequest, aContext, aStatusCode) {
					pipe.outputStream.close();
					aCallback(pipe.inputStream, aStatusCode);
				}
			});

			channel.asyncOpen(listener, null);
		}
	},
	
	readFile: function(aFile,headerOnly)
	{
		try
		{
			let stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
			stream.init(aFile, 0x01, 0, 0);
			let cvstream = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);
			cvstream.init(stream, "UTF-8", 1024, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
			
			let content = "";
			let data = {};
			while (cvstream.readString(4096, data))
			{
				content += data.value;
				if (headerOnly) break;
			}
			cvstream.close();
			
			return content.replace(/\r\n?/g, "\n");
		}
		catch (ex) { }
		
		return null;
	},

	writeFile: function(aFile, aData, aCallback)
	{
		if (!aData) return;  // this handles case where data could not be encrypted and null was passed to writeFile
		aData = aData.replace(/\n/g, _EOL);  // Change EOL for OS
		let ostream = Cc["@mozilla.org/network/safe-file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
		ostream.init(aFile, 0x02 | 0x08 | 0x20, 0600, 0);
		let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"].createInstance(Ci.nsIScriptableUnicodeConverter);
		converter.charset = "UTF-8";
		
		// Use NetUtil to asynchronous write if availalble (Firefox 3.6 and above), otherwise use use our own version
		if (typeof NetUtil != "undefined") {
			// Asynchronously copy the data to the file.
			let istream = converter.convertToInputStream(aData);
			NetUtil.asyncCopy(istream, ostream, aCallback);
		}
		else {
			let convertedData = converter.ConvertFromUnicode(aData);
			convertedData += converter.Finish();

			// write and close stream
			ostream.write(convertedData, convertedData.length);
			if (ostream instanceof Ci.nsISafeOutputStream) {
				ostream.finish();
			} else {
				ostream.close();
			}
			
			// Fake a successful callback
			if (typeof aCallBack == "function") aCallBack(0);
		}
	},

	delFile: function(aFile, aSilent)
	{
		if (aFile && aFile.exists())
		{
			try
			{
				aFile.remove(false);
			}
			catch (ex)
			{
				if (!aSilent)
				{
					this.ioError(ex);
				}
			}
		}
	},
	
	moveToCorruptFolder: function(aFile, aSilent)
	{
		try {
			if (aFile.exists()) 
			{
				let dir = this.getSessionDir();
				dir.append("Corrupt_Sessions");
		
				if (!dir.exists()) {
					dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0700);
				}
		
				aFile.moveTo(dir, null);
			}
		}	
		catch (ex) { 
			if (!aSilent) this.ioError(ex); 
		}
	},
	
/* ........ Encryption functions .............. */

	cryptError: function(aException, notSaved)
	{
		let text;
		if (aException.message) {
			if (aException.message.indexOf("decryptString") != -1) {
				if (aException.name != "NS_ERROR_NOT_AVAILABLE") {
					text = this._string("decrypt_fail1");
				}
				else {
					text = this._string("decrypt_fail2");
				}
			}
			else {
				text = notSaved ? this._string("encrypt_fail2") : this._string("encrypt_fail");
			}
		}
		else text = aException;
		this.threadSafeAlert(text);
	},

	decrypt: function(aData, aNoError, doNotDecode)
	{
		// Encrypted data is in BASE64 format so ":" won't be in encrypted data, but is in session data.
		// The encryptString function cannot handle non-ASCII data so encode it first and decode the results
		if (aData.indexOf(":") == -1)
		{
			try {
				aData = SECRET_DECODER_RING_SERVICE.decryptString(aData);
				if (!doNotDecode) aData = decodeURIComponent(aData);
			}
			catch (ex) { 
				logError(ex);
				if (!aNoError) this.cryptError(ex); 
				// encrypted file corrupt, return false so as to not break things checking for aData.
				if (ex.name != "NS_ERROR_NOT_AVAILABLE") { 
					return false;
				}
				return null;
			}
		}
		return aData;
	},

	// This function will encrypt the data if the encryption preference is set.
	// It will also decrypt encrypted data if the encryption preference is not set.
	decryptEncryptByPreference: function(aData, aSilent)
	{
		// Encrypted data is in BASE64 format so ":" won't be in encrypted data, but is in session data.
		// The encryptString function cannot handle non-ASCII data so encode it first and decode the results
		let encrypted = (aData.indexOf(":") == -1);
		try {
			if (this.mPref_encrypt_sessions && !encrypted)
			{
				aData = SECRET_DECODER_RING_SERVICE.encryptString(encodeURIComponent(aData));
			}
			else if (!this.mPref_encrypt_sessions && encrypted)
			{
				aData = decodeURIComponent(SECRET_DECODER_RING_SERVICE.decryptString(aData));
			}
		}
		catch (ex) { 
			if (!aSilent) {
				if (!encrypted && this.mPref_encrypted_only) {
					this.cryptError(ex, true);
					return null;
				}
				else this.cryptError(ex);
			}
			else {
				return ex;
			}
		}
		return aData;
	},
	
	encryptionChange: function()
	{
		// force a master password prompt so we don't waste time if user cancels it
		if (PasswordManager.enterMasterPassword()) 
		{
			// disable checkbox to prevent user from switching again until processing is finished.
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:encryption-change", "start");
			EncryptionChangeHandler.changeEncryption();
		}
		// failed to encrypt/decrypt so revert setting
		else {
			gPreferenceManager.set("encrypt_sessions",!this.mPref_encrypt_sessions);
			this.cryptError(this._string("change_encryption_fail"));
		}
	},
/* ........ Conversion functions .............. */

	convertEntryToLatestSessionFormat: function(aEntry)
	{
		// Convert Postdata
		if (aEntry.postdata) {
			aEntry.postdata_b64 = btoa(aEntry.postdata);
		}
		delete aEntry.postdata;
	
		// Convert owner
		if (aEntry.ownerURI) {
			let uriObj = IO_SERVICE.newURI(aEntry.ownerURI, null, null);
			let owner = Cc["@mozilla.org/scriptsecuritymanager;1"].getService(Ci.nsIScriptSecurityManager).getCodebasePrincipal(uriObj);
			try {
				let binaryStream = Cc["@mozilla.org/binaryoutputstream;1"].
								   createInstance(Ci.nsIObjectOutputStream);
				let pipe = Cc["@mozilla.org/pipe;1"].createInstance(Ci.nsIPipe);
				pipe.init(false, false, 0, 0xffffffff, null);
				binaryStream.setOutputStream(pipe.outputStream);
				binaryStream.writeCompoundObject(owner, Ci.nsISupports, true);
				binaryStream.close();

				// Now we want to read the data from the pipe's input end and encode it.
				let scriptableStream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
				scriptableStream.setInputStream(pipe.inputStream);
				let ownerBytes = scriptableStream.readByteArray(scriptableStream.available());
				// We can stop doing base64 encoding once our serialization into JSON
				// is guaranteed to handle all chars in strings, including embedded
				// nulls.
				aEntry.owner_b64 = btoa(String.fromCharCode.apply(null, ownerBytes));
			}
			catch (ex) { logError(ex); }
		}
		delete aEntry.ownerURI;
	
		// convert children
		if (aEntry.children) {
			for (var i = 0; i < aEntry.children.length; i++) {
				//XXXzpao Wallpaper patch for bug 514751
				if (!aEntry.children[i].url)
					continue;
				aEntry.children[i] = this.convertEntryToLatestSessionFormat(aEntry.children[i]);
			}
		}
		
		return aEntry;
	},
	
	convertTabToLatestSessionFormat: function(aTab)
	{
		// Convert XULTAB to attributes
		if (aTab.xultab) {
			if (!aTab.attributes) aTab.attributes = {};
			// convert attributes from the legacy Firefox 2.0/3.0 format
			aTab.xultab.split(" ").forEach(function(aAttr) {
				if (/^([^\s=]+)=(.*)/.test(aAttr)) {
					aTab.attributes[RegExp.$1] = RegExp.$2;
				}
			}, this);
		}
		delete aTab.xultab;

		// Convert text data
		if (aTab.text) {
			if (!aTab.formdata) aTab.formdata = {};
			let textArray = aTab.text ? aTab.text.split(" ") : [];
			textArray.forEach(function(aTextEntry) {
				if (/^((?:\d+\|)*)(#?)([^\s=]+)=(.*)$/.test(aTextEntry)) {
					let key = RegExp.$2 ? "#" + RegExp.$3 : "//*[@name='" + RegExp.$3 + "']";
					aTab.formdata[key] = RegExp.$4;
				}
			});
		}
		delete aTab.text;
		
		// Loop and convert entries
		aTab.entries.forEach(function(aEntry) {
			aEntry = this.convertEntryToLatestSessionFormat(aEntry);
		}, this);
		
		return aTab;
	},
	
	convertWindowToLatestSessionFormat: function(aWindow)
	{
		// Loop tabs
		aWindow.tabs.forEach(function(aTab) {
			aTab = this.convertTabToLatestSessionFormat(aTab);
		}, this);
		
		// Loop closed tabs
		if (aWindow._closedTabs) {
			aWindow._closedTabs.forEach(function(aTab) {
				aTab.state = this.convertTabToLatestSessionFormat(aTab.state);
			}, this);
		}
		return aWindow;
	},

	convertToLatestSessionFormat: function(aFile, aState)
	{
		log("Converting " + aFile.leafName + " to latest format", "TRACE");
		
		let state = aState.split("\n");
		// decrypt if encrypted, do not decode if in old format since old format was not encoded
		state[4] = this.decrypt(state[4], true);
		
		// convert to object
		state[4] = this.JSON_decode(state[4], true);
		
		// Loop and convert windows
		state[4].windows.forEach(function(aWindow) {
			aWindow = this.convertWindowToLatestSessionFormat(aWindow);
		}, this);

		// Loop and convert closed windows
		if (state[4]._closedWindows) {
			state[4]._closedWindows.forEach(function(aWindow) {
				aWindow = this.convertWindowToLatestSessionFormat(aWindow);
			}, this);
		}
		
		// replace state
		state[4] = this.JSON_encode(state[4]);
		state[4] = this.decryptEncryptByPreference(state[4], true);
		state = state.join("\n");
		
		// Make a backup of old session in case something goes wrong
		try {
			if (aFile.exists()) 
			{
				let newFile = aFile.clone();
				
				let dir = this.getSessionDir();
				dir.append("Old_Format_Sessions");
		
				if (!dir.exists()) {
					dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0700);
				}
		
				newFile.moveTo(dir, null);
			}
		}	
		catch (ex) { 
			logError(ex); 
		}
		
		// Save session
		this.writeFile(aFile, state);

		return state;
	},

	decodeOldFormat: function(aIniString, moveClosedTabs)
	{
		let rootObject = {};
		let obj = rootObject;
		let lines = aIniString.split("\n");
	
		for (let i = 0; i < lines.length; i++)
		{
			try
			{
				if (lines[i].charAt(0) == "[")
				{
					obj = this.ini_getObjForHeader(rootObject, lines[i]);
				}
				else if (lines[i] && lines[i].charAt(0) != ";")
				{
					this.ini_setValueForLine(obj, lines[i]);
				}
			}
			catch (ex)
			{
				throw new Error("Error at line " + (i + 1) + ": " + ex.description);
			}
		}
	
		// move the closed tabs to the right spot
		if (moveClosedTabs == true)
		{
			try
			{
				rootObject.windows.forEach(function(aValue, aIndex) {
					if (aValue.tabs && aValue.tabs[0]._closedTabs)
					{
						aValue["_closedTabs"] = aValue.tabs[0]._closedTabs;
						delete aValue.tabs[0]._closedTabs;
					}
				}, this);
			}
			catch (ex) {}
		}
	
		return rootObject;
	},

	ini_getObjForHeader: function(aObj, aLine)
	{
		let names = aLine.split("]")[0].substr(1).split(".");
	
		for (let i = 0; i < names.length; i++)
		{
			if (!names[i])
			{
				throw new Error("Invalid header: [" + names.join(".") + "]!");
			}
			if (/(\d+)$/.test(names[i]))
			{
				names[i] = names[i].slice(0, -RegExp.$1.length);
				let ix = parseInt(RegExp.$1) - 1;
				names[i] = this.ini_fixName(names[i]);
				aObj = aObj[names[i]] = aObj[names[i]] || [];
				aObj = aObj[ix] = aObj[ix] || {};
			}
			else
			{
				names[i] = this.ini_fixName(names[i]);
				aObj = aObj[names[i]] = aObj[names[i]] || {};
			}
		}
	
		return aObj;
	},

	ini_setValueForLine: function(aObj, aLine)
	{
		let ix = aLine.indexOf("=");
		if (ix < 1)
		{
			throw new Error("Invalid entry: " + aLine + "!");
		}
	
		let value = aLine.substr(ix + 1);
		if (value == "true" || value == "false")
		{
			value = (value == "true");
		}
		else if (/^\d+$/.test(value))
		{
			value = parseInt(value);
		}
		else if (value.indexOf("%") > -1)
		{
			value = decodeURI(value.replace(/%3B/gi, ";"));
		}
		
		let name = this.ini_fixName(aLine.substr(0, ix));
		if (name == "xultab")
		{
			//this.ini_parseCloseTabList(aObj, value);
		}
		else
		{
			aObj[name] = value;
		}
	},

	// This results in some kind of closed tab data being restored, but it is incomplete
	// as all closed tabs show up as "undefined" and they don't restore.  If someone
	// can fix this feel free, but since it is basically only used once I'm not going to bother.
	ini_parseCloseTabList: function(aObj, aCloseTabData)
	{
		let ClosedTabObject = {};
		let ix = aCloseTabData.indexOf("=");
		if (ix < 1)
		{
			throw new Error("Invalid entry: " + aCloseTabData + "!");
		}
		let serializedTabs = aCloseTabData.substr(ix + 1);
		serializedTabs = decodeURI(serializedTabs.replace(/%3B/gi, ";"));
		let closedTabs = serializedTabs.split("\f\f").map(function(aData) {
			if (/^(\d+) (.*)\n([\s\S]*)/.test(aData))
			{
				return { name: RegExp.$2, pos: parseInt(RegExp.$1), state: RegExp.$3 };
			}
			return null;
		}).filter(function(aTab) { return aTab != null; }).slice(0, gPreferenceManager.get("browser.sessionstore.max_tabs_undo", 10, true));

		closedTabs.forEach(function(aValue, aIndex) {
			closedTabs[aIndex] = this.decodeOldFormat(aValue.state, false)
			closedTabs[aIndex] = closedTabs[aIndex].windows;
			closedTabs[aIndex] = closedTabs[aIndex][0].tabs;
		}, this);

		aObj["_closedTabs"] = [];

		closedTabs.forEach(function(aValue, aIndex) {
			aObj["_closedTabs"][aIndex] = this.JSON_decode({ state : this.JSON_encode(aValue[0]) });
		}, this);
	},

	ini_fixName: function(aName)
	{
		switch (aName)
		{
			case "Window":
				return "windows";
			case "Tab":
				return "tabs";
			case "Entry":
				return "entries";
			case "Child":
				return "children";
			case "Cookies":
				return "cookies";
			case "uri":
				return "url";
			default:
				return aName;
		}			
	},

/* ........ Miscellaneous Enhancements .............. */

	// Check for Running
	isRunning: function() {
		return Application.storage.get("sessionmanager._running", false);
	},
	
	// Check for Running
	setRunning: function(aValue) {
		return Application.storage.set("sessionmanager._running", aValue);
	},

	// Caching functions
	getSessionCache: function(aName) {
		return Application.storage.get(this.mSessionCache + aName, null);
	},
	
	setSessionCache: function(aName, aData) {
		Application.storage.set(this.mSessionCache + aName, aData);
	},
	
	getClosedWindowCache: function(aData, aLengthOnly) {
		if (aData && aLengthOnly) {
			return Application.storage.get(this.mClosedWindowsCacheLength, 0);
		}
		else if (aData) {
			return Application.storage.get(this.mClosedWindowsCacheData, null);
		}
		else {
			return Application.storage.get(this.mClosedWindowsCacheTimestamp, 0);
		}
	},

	setClosedWindowCache: function(aData, aTimestamp) {
		Application.storage.set(this.mClosedWindowsCacheData, aData);
		Application.storage.set(this.mClosedWindowsCacheTimestamp, (aData ? aTimestamp : 0));
		Application.storage.set(this.mClosedWindowsCacheLength, (aData ? aData.split("\n\n").length : 0));
	},
	
	// Read Autosave values from preference and store into global variables
	getAutoSaveValues: function(aValues, aWindow)
	{
		if (!aValues) aValues = "";
		log("getAutoSaveValues: aWindow = " + (aWindow ? aWindow.content.document.title : "null") + ", aValues = " + aValues.split("\n").join(", "), "EXTRA");
		let values = aValues.split("\n");
		if (aWindow) {
			let old_window_session_name = aWindow.com.morac.gSessionManagerWindowObject.__window_session_name;
			aWindow.com.morac.gSessionManagerWindowObject.__window_session_name = values[0];
			aWindow.com.morac.gSessionManagerWindowObject.__window_session_group = values[1];
			aWindow.com.morac.gSessionManagerWindowObject.__window_session_time = (!values[2] || isNaN(values[2])) ? 0 : values[2];
			try {
				// This throws whenever a window is already closed (during shutdown for example) or if the value doesn't exist and we try to delete it
				if (aValues) {
					// Store window session into Application storage and set window value
					this.mActiveWindowSessions[values[0].trim().toLowerCase()] = true;
					SessionStore.setWindowValue(aWindow, "_sm_window_session_values", aValues);
				}
				else {
					if (old_window_session_name) {
						// Remove window session from Application storage and delete window value
						delete this.mActiveWindowSessions[old_window_session_name.trim().toLowerCase()];
					}
					SessionStore.deleteWindowValue(aWindow, "_sm_window_session_values");
					
					// the following forces SessionStore to save the state to disk (bug 510965)
					// Can't just set _sm_window_session_values to "" and then delete since that will throw an exception
					SessionStore.setWindowValue(aWindow, "SM_dummy_value","1");
					SessionStore.deleteWindowValue(aWindow, "SM_dummy_value");
				}
			}
			catch(ex) {
				// log it so we can tell when things aren't working.  Don't log exceptions in deleteWindowValue
				// because it throws an exception if value we are trying to delete doesn't exist. Since we are 
				// deleting the value, we don't care if it doesn't exist.
				if (ex.message.indexOf("deleteWindowValue") == -1) logError(ex);
			}
			
			// start/stop window timer
			aWindow.com.morac.gSessionManagerWindowObject.checkWinTimer();
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:updatetitlebar", null);
		}
		else {
			this.mPref__autosave_name = values[0];
			this.mPref__autosave_group = values[1];
			this.mPref__autosave_time = (!values[2] || isNaN(values[2])) ? 0 : values[2];
		}

		// Update tab tree if it's open
		OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:update-session-tree", null);
	},

	// Merge autosave variables into a a string
	mergeAutoSaveValues: function(name, group, time)
	{
		let values = [ name, group, time ];
		return values.join("\n");
	},
	
	// Bug 374288 causes all elements that don't have a specified tooltip or tooltiptext to inherit their
	// ancestors tooltip/tooltiptext.  To work around this set a blank tooltiptext for all descendents of aNode.
	//
	fixBug374288: function(aNode)
	{
		if (aNode && aNode.childNodes) {
			for (let i in aNode.childNodes) {
				let child = aNode.childNodes[i];
				if (child && child.getAttribute && !child.getAttribute("tooltiptext")) {
					child.setAttribute("tooltiptext", "");
				}
				this.fixBug374288(child);
			}
		}
	},

	// Called to handle clearing of private data (stored sessions) when the toolbar item is selected
	// and when the clear now button is pressed in the privacy options pane.  If the option to promptOnSanitize
	// is set, this function ignores the request and let's the Firefox Sanitize function call
	// gSessionManager.santize when Clear Private Data okay button is pressed and Session Manager's checkbox
	// is selected.  This is only called in Firefox 3.0 and SeaMonkey 2.0.
	tryToSanitize: function()
	{
		// User disabled the prompt before clear option and session manager is checked in the privacy data settings
		if ( !gPreferenceManager.get("privacy.sanitize.promptOnSanitize", true, true) &&
			 gPreferenceManager.get("privacy.item.extensions-sessionmanager", false, true) ) 
		{
			this.sanitize();
			return true;
		}
	
		return false;
	},
		
	recoverSession: function(aWindow)
	{
		let file, temp_restore = null, first_temp_restore = null, temp_restore_index = 1;
		// Use SessionStart's value in FF3 because preference is cleared by the time we are called
		let sessionstart = (SessionStartup.sessionType != Ci.nsISessionStartup.NO_SESSION) && !this.mAlreadyShutdown;
		let recoverOnly = this.isRunning() || sessionstart || this._no_prompt_for_session;
		this._no_prompt_for_session = false;
		log("recoverSession: recovering = " + (this._recovering ? this._recovering.fileName : "null") + ", sessionstart = " + sessionstart + ", recoverOnly = " + recoverOnly, "DATA");
		if (typeof(this._temp_restore) == "string") {
			log("recoverSession: command line session data = \"" + this._temp_restore + "\"", "DATA");
			temp_restore = this._temp_restore.split("\n");
			first_temp_restore = temp_restore[1];
		}
		this._temp_restore = null;

		// handle crash where user chose a specific session
		if (this._recovering)
		{
			let recovering = this._crash_session_filename = this._recovering.fileName;
			let sessionState = this._recovering.sessionState;
			this._recovering = null;
			this.load(aWindow, recovering, "startup", sessionState);
			// Clear out return data and preset to not accepting
			this.sessionPromptReturnData = null;
		}
		else if (!recoverOnly && (this.mPref_restore_temporary || first_temp_restore || (this.mPref_startup == 1) || ((this.mPref_startup == 2) && this.mPref_resume_session)) && this.getSessions().length > 0)
		{
			// allow prompting for tabs in Firefox 3.5
			let values = { ignorable: true, preselect: this.mPref_preselect_previous_session, no_parent_window: true, startupPrompt: true };
			
			// Order preference:
			// 1. Temporary backup session
			// 2. Prompt or selected session
			// 3. Command line session.
			let session = (this.mPref_restore_temporary)?BACKUP_SESSION_FILENAME:((this.mPref_startup == 1)?this.selectSession(this._string("resume_session"), this._string("resume_session_ok"), values):
			              ((this.mPref_startup == 2)?this.mPref_resume_session:first_temp_restore));
			// If no session chosen to restore, use the command line specified session
			if (!session) session = first_temp_restore;
			if (session && (session == first_temp_restore)) {
				log("recoverSession: Restoring startup command line session \"" + first_temp_restore + "\"", "DATA");
				// Go to next command line item if it exists
				temp_restore_index++;
			}
			log("recoverSession: Startup session = " + session, "DATA");
			if (session && (file = this.getSessionDir(session)) && (file.exists() || (session == BACKUP_SESSION_FILENAME)))
			{
				// If user chooses to restore backup session, but there is no backup session, then an auto-save session was open when 
				// browser closed so restore that.
				if (!file.exists()) {
					let sessions = this.getSessions();
					// if latest user saved session newer than latest backup session
					if (sessions.latestBackUpTime < sessions.latestTime) {
						// find latest session if it's an autosave session
						session = sessions.filter(function(element, index, array) {  
							return ((sessions.latestTime == element.timestamp) && /^window|session/.exec(element.autosave));  
						})[0];
						if (session) {
							session = session.fileName;
							log("recoverSession: Backup session not found, using autosave session = " + session, "DATA");
						}
					}
					else session = null;
				}
				if (session) this.load(aWindow, session, "startup", values.sessionState);
				else log("recoverSession: Backup session not found.", "TRACE");
			}
			// if user set to resume previous session, don't clear this so that way user can choose whether to backup
			// current session or not and still have it restore.
			else if ((this.mPref_startup == 2) && (this.mPref_resume_session != BACKUP_SESSION_FILENAME)) {
				gPreferenceManager.set("resume_session",BACKUP_SESSION_FILENAME);
				gPreferenceManager.set("startup",0);
			}
			if (values.ignore)
			{
				gPreferenceManager.set("resume_session", session || BACKUP_SESSION_FILENAME);
				gPreferenceManager.set("startup", (session)?2:0);
			}
			// Display Home Page if user selected to do so
			//if (display home page && this.isCmdLineEmpty(aWindow)) {
			//	BrowserHome();
			//}
		}
		// handle browser reload with same session and when opening new windows
		else if (recoverOnly) {
			this.checkTimer();
		}
		
		// Not shutdown 
		this.mAlreadyShutdown = false;
		
		// Restore command line specified session(s) in a new window if they haven't been restored already
		if (first_temp_restore) {
			// For each remaining session in the command line
			while (temp_restore.length > temp_restore_index) {
				file = this.getSessionDir(temp_restore[temp_restore_index]);
				log(file.path);
				if (file && file.exists()) {
					log("recoverSession: Restoring additional command line session " + temp_restore_index + " \"" + temp_restore[temp_restore_index] + "\"", "DATA");
					// Only restore into existing window if not startup and first session in command line
					this.load(aWindow, temp_restore[temp_restore_index], (((temp_restore_index > 1) || (temp_restore[0] == "0")) ? "newwindow_always" : "overwrite_window"));
				}
				temp_restore_index++;
			}
		}
		
		// If need to encrypt backup file, do it
		if (this._encrypt_file) {
			let file = this.getSessionDir(this._encrypt_file);
			this._encrypt_file = null;
			let state = this.readSessionFile(file);
			if (state) 
			{
				if (SESSION_REGEXP.test(state))
				{
					state = state.split("\n")
					state[4] = this.decryptEncryptByPreference(state[4]);
					// if could be encrypted or encryption failed but user allows unencrypted sessions
					if (state[4]) {
						// if encrypted save it
						if (state[4].indexOf(":") == -1) {
							state = state.join("\n");
							this.writeFile(file, state);
						}
					}
					// couldn't encrypt and user does not want unencrypted files so delete it
					else this.delFile(file);
				}
				else this.delFile(file);
			}
		}
	},

	isCmdLineEmpty: function(aWindow)
	{
		if (Application.name.toUpperCase() != "SEAMONKEY") {
			try {
				// Use the defaultArgs, unless SessionStore was trying to resume or handle a crash.
				// This handles the case where the browser updated and SessionStore thought it was supposed to display the update page, so make sure we don't overwrite it.
				let defaultArgs = (SessionStartup.sessionType != Ci.nsISessionStartup.NO_SESSION) ? 
				                  Cc["@mozilla.org/browser/clh;1"].getService(Ci.nsIBrowserHandler).startPage :
				                  Cc["@mozilla.org/browser/clh;1"].getService(Ci.nsIBrowserHandler).defaultArgs;
				if (aWindow.arguments && aWindow.arguments[0] && aWindow.arguments[0] == defaultArgs) {
					aWindow.arguments[0] = null;
				}
				return !aWindow.arguments || !aWindow.arguments[0];
			}
			catch(ex) {
				logError(ex);
				return false;
			}
		}
		else {
			let startPage = "about:blank";
			if (gPreferenceManager.get("browser.startup.page", 1, true) == 1) {
				startPage = this.SeaMonkey_getHomePageGroup();
			}
			return "arguments" in aWindow && aWindow.arguments.length && (aWindow.arguments[0] == startPage);
		}
	},

	SeaMonkey_getHomePageGroup: function()
	{
		let homePage = gPreferenceManager.get("browser.startup.homepage", "", true);
		let count = gPreferenceManager.get("browser.startup.homepage.count", 0, true);

		for (let i = 1; i < count; ++i) {
			homePage += '\n' + gPreferenceManager.get("browser.startup.homepage." + i, "", true);
		}
		return homePage;
	},
	
	// Return private browsing mode (PBM) state - If user choose to allow saving in PBM and encryption
	// is enabled, return false.
	isPrivateBrowserMode: function()
	{
		// Private Browsing Mode is only available in Firefox 3.5 and above
		if (PrivateBrowsing) {
			return PrivateBrowsing.privateBrowsingEnabled;
		}
		else {
			return false;
		}
	},

	isAutoStartPrivateBrowserMode: function()
	{
		// Private Browsing Mode is only available in Firefox 3.5 and above
		if (PrivateBrowsing) {
			return PrivateBrowsing.autoStarted;
		}
		else {
			return false;
		}
	},

	checkTimer: function()
	{
		// only act if timer already started
		if (this._timer && ((this.mPref__autosave_time <= 0) || !this.mPref__autosave_name)) {
			this._timer.cancel();
			this._timer = null;
			log("checkTimer: Session Timer stopped", "INFO");
		}
		else if (!this._timer && (this.mPref__autosave_time > 0) && this.mPref__autosave_name) {
			log("checkTimer: Check if session timer already running and if not start it", "INFO");
			this._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
			this._timer.init(gSessionManager, this.mPref__autosave_time * 60000, Ci.nsITimer.TYPE_REPEATING_PRECISE);
			log("checkTimer: Session Timer started for " + this.mPref__autosave_time + " minutes", "INFO");
		}
	},
	
/* ........ Auxiliary Functions .............. */
	getNoUndoData: function(aLoad, aMode)
	{
		return aLoad ? { tabs: (!this.mPref_save_closed_tabs || (this.mPref_save_closed_tabs == 1 && (aMode != "startup"))),
		                 windows: (!this.mPref_save_closed_windows || (this.mPref_save_closed_windows == 1 && (aMode != "startup"))) }
		             : { tabs: (this.mPref_save_closed_tabs < 2), windows: (this.mPref_save_closed_windows < 2) };
	},

	// count windows and tabs
	getCount: function(aState)
	{
		let windows = 0, tabs = 0;
		
		try {
			let state = this.JSON_decode(aState);
			state.windows.forEach(function(aWindow) {
				windows = windows + 1;
				tabs = tabs + aWindow.tabs.length;
			});
		}
		catch (ex) { logError(ex); };

		return { windows: windows, tabs: tabs };
	},
	
	getSessionState: function(aName, aWindow, aNoUndoData, aAutoSave, aGroup, aDoNotEncrypt, aAutoSaveTime, aState, aMergeState)
	{
		// aState - State JSON string to use instead of the getting the current state.
		// aMergeState - State JSON string to merge with either the current state or aState.
		//
		// The passed in state is used for saving old state when shutting down in private browsing mode and when saving specific windows
		// The merge state is used to append to sessions.
		if (aState) log("getSessionState: " + (aMergeState ? "Merging" : "Returning") + " passed in state", "INFO");
		let state;
		try {
			try {
				state = aState ? aState : (aWindow ? SessionStore.getWindowState(aWindow) : SessionStore.getBrowserState());
			}
			catch(ex) {
				// If this exception is a "this._prefBranch is undefined" then force SessionStore to initialize and try again
				// otherwise just re-throw
				if (ex.message.indexOf("this._prefBranch is undefined") != -1) {
					SessionStore.init(aWindow);
					state = aState ? aState : (aWindow ? SessionStore.getWindowState(aWindow) : SessionStore.getBrowserState());
				}
				else throw(ex);
			}
			
			if (aMergeState) {
				state = this.JSON_decode(state);
				aMergeState = this.JSON_decode(aMergeState);
				state.windows = state.windows.concat(aMergeState.windows);
				if (state._closedWindows && aMergeState._closedWindows) state._closedWindows = state._closedWindows.concat(aMergeState._closedWindows);
				state = this.JSON_encode(state);
			}
		}
		catch(ex) {
			// Log and rethrow errors
			logError(ex);
			throw(ex);
		}
		
		state = this.modifySessionData(state, aNoUndoData, true);
		let count = this.getCount(state);
		
		// encrypt state if encryption preference set and flag not set
		if (!aDoNotEncrypt) {
			state = this.decryptEncryptByPreference(state); 
			if (!state) return null;
		}

		let window = aWindow || this.getMostRecentWindow();
		let width = null;
		let height = null;
		if (window && (typeof(window) == "object")) {
			width = window.screen.width;
			height = window.screen.height;
		}
		
		return (aName != null)?this.nameState("timestamp=" + Date.now() + "\nautosave=" + ((aAutoSave)?aWindow?("window/" + aAutoSaveTime):("session/" + aAutoSaveTime):"false") +
		                                      "\tcount=" + count.windows + "/" + count.tabs + (aGroup? ("\tgroup=" + aGroup.replace(/\t/g, " ")) : "") +
		                                      "\tscreensize=" + (this._screen_width || width) + "x" + (this._screen_height || height) + "\n" + state, aName || "") : state;
	},

	restoreSession: function(aWindow, aState, aReplaceTabs, aNoUndoData, aEntireSession, aOneWindow, aStartup, aWindowSessionValues, xDelta, yDelta, aFileName)
	{
		log("restoreSession: aWindow = " + aWindow + ", aReplaceTabs = " + aReplaceTabs + ", aNoUndoData = " + (aNoUndoData ? NATIVE_JSON.encode(aNoUndoData) : "undefined") + 
		         ", aEntireSession = " + aEntireSession + ", aOneWindow = " + aOneWindow + ", aStartup = " + aStartup + 
				 ", aWindowSessionValues = " + (aWindowSessionValues ? ("\"" + aWindowSessionValues.split("\n").join(", ") + "\"") : "undefined") + ", xDelta = " + xDelta + 
				 ", yDelta = " + yDelta + ", aFileName = " + aFileName, "DATA");
		// decrypt state if encrypted
		aState = this.decrypt(aState);
		if (!aState) return false;
		
		if (!aWindow)
		{
			aWindow = this.openWindow(gPreferenceManager.get("browser.chromeURL", null, true), "chrome,all,dialog=no");
			aWindow.__SM_restore = function() {
				this.removeEventListener("load", this.__SM_restore, true);
				gSessionManager.restoreSession(this, aState, aReplaceTabs, aNoUndoData, null, null, null, aWindowSessionValues, xDelta, yDelta, aFileName);
				delete this.__SM_restore;
			};
			aWindow.addEventListener("load", aWindow.__SM_restore, true);
			return true;
		}

		aState = this.modifySessionData(aState, aNoUndoData, false, aEntireSession, aStartup, xDelta, yDelta);  

		if (aEntireSession)
		{
			try {
				SessionStore.setBrowserState(aState);
			}
			catch(ex) {
				// If this exception is a "this._prefBranch is undefined" then force SessionStore to initialize and try again
				// otherwise just re-throw
				if (ex.message.indexOf("this._prefBranch is undefined") != -1) {
					SessionStore.init(aWindow);
					SessionStore.setBrowserState(aState);
				}
				else throw(ex);
			}
		}
		else
		{
			if (aOneWindow) aState = this.makeOneWindow(aState);
			try {
				SessionStore.setWindowState(aWindow, aState, aReplaceTabs || false);
			}
			catch(ex) {
				// If this exception is a "this._prefBranch is undefined" then force SessionStore to initialize and try again
				// otherwise just re-throw
				if (ex.message.indexOf("this._prefBranch is undefined") != -1) {
					SessionStore.init(aWindow);
					SessionStore.setWindowState(aWindow, aState, aReplaceTabs || false);
				}
				else throw(ex);
			}
		}
		
		// Store autosave values into window value and also into window variables
		if (!aWindow.com.morac.gSessionManagerWindowObject.__window_session_name) {
			// Backup _sm_window_session_values first in case we want to restore window sessions from non-window session.
			// For example, in the case of loading the backup session at startup.
			aWindow.com.morac.gSessionManagerWindowObject._backup_window_sesion_data = SessionStore.getWindowValue(aWindow,"_sm_window_session_values");
			log("restoreSession: Removed window session name from window: " + aWindow.com.morac.gSessionManagerWindowObject._backup_window_sesion_data, "DATA");
			this.getAutoSaveValues(aWindowSessionValues, aWindow);
		}
		log("restoreSession: restore done, window_name  = " + aWindow.com.morac.gSessionManagerWindowObject.__window_session_name, "DATA");
		// On Startup, if restoring backup session tell Session Manager Component the number of windows being restored.  
		// Subtract one since the current window counts as #1.
		if (aStartup && (aFileName == this._crash_session_filename || aFileName == BACKUP_SESSION_FILENAME)) {
			this._countWindows = true;
			// if recovering from crash, sessionstore:windows-restored notification is ignored so sessionmanager window count will already be one so don't subract anything.
			let tweaker = this._crash_session_filename ? 0 : 1;
			OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:windows-restored", this._number_of_windows - tweaker);
		}

		// Save session manager window value for aWindow since it will be overwritten on load.  Other windows opened will have the value set correctly.
		if (aWindow.__SSi && aWindow.com.morac.gSessionManagerWindowObject) {
			aWindow.com.morac.gSessionManagerWindowObject.__SessionManagerWindowId = aWindow.__SSi;
			SessionStore.setWindowValue(aWindow, "__SessionManagerWindowId", aWindow.__SSi);
		}
		
		return true;
	},

	nameState: function(aState, aName)
	{
		if (!/^\[SessionManager v2\]/m.test(aState))
		{
			return "[SessionManager v2]\nname=" + aName.replace(/\t/g, " ") + "\n" + aState;
		}
		return aState.replace(/^(\[SessionManager v2\])(?:\nname=.*)?/m, function($0, $1) { return $1 + "\nname=" + aName.replace(/\t/g, " "); });
	},
	
	makeOneWindow: function(aState)
	{
		aState = this.JSON_decode(aState);
		if (aState.windows.length > 1)
		{
			// take off first window
			let firstWindow = aState.windows.shift();
			// make sure toolbars are not hidden on the window
			delete firstWindow.hidden;
			// Move tabs to first window
			aState.windows.forEach(function(aWindow) {
				while (aWindow.tabs.length > 0)
				{
					this.tabs.push(aWindow.tabs.shift());
				}
			}, firstWindow);
			// Remove all but first window
			aState.windows = [];
			aState.windows[0] = firstWindow;
		}
		return this.JSON_encode(aState);
	},
	
	modifySessionData: function(aState, aNoUndoData, aSaving, aReplacingWindow, aStartup, xDelta, yDelta)
	{
		if (!xDelta) xDelta = 1;
		if (!yDelta) yDelta = 1;
	
		// Don't do anything if not modifying session data
		if (!(aNoUndoData || (aSaving && !this.mPref_save_cookies) || aReplacingWindow || aStartup || (xDelta != 1) || (yDelta != 1))) {
			return aState;
		}
		aState = this.JSON_decode(aState);
		
		// set _firsttabs to true on startup to prevent closed tabs list from clearing when not overwriting tabs.
		if (aStartup) aState._firstTabs = true;
		
		let fixWindow = function(aWindow) {
			// Strip out cookies if user doesn't want to save them
			if (aSaving && !this.mPref_save_cookies) delete aWindow.cookies;

			// remove closed tabs			
			if (aNoUndoData && aNoUndoData.tabs) aWindow._closedTabs = [];
			
			// adjust window position and height if screen dimensions don't match saved screen dimensions
			aWindow.width = aWindow.width * xDelta;
			aWindow.height = aWindow.height * yDelta;
			aWindow.screenX = aWindow.screenX * xDelta;
			aWindow.screenY = aWindow.screenY * yDelta;
		};
		
		// process opened windows
		aState.windows.forEach(fixWindow, this);
		
		// process closed windows (for sessions only)
		if (aState._closedWindows) {
			if (this.mUseSSClosedWindowList && aNoUndoData && aNoUndoData.windows) {
				aState._closedWindows = [];
			}
			else  {
				aState._closedWindows.forEach(fixWindow, this);
			}
		}

		// if only one window, don't allow toolbars to be hidden
		if (aReplacingWindow && (aState.windows.length == 1) && aState.windows[0].hidden) {
			delete aState.windows[0].hidden;
			// Since nothing is hidden in the first window, it cannot be a popup (see Firefox bug 519099)
			delete aState.windows[0].isPopup;
		}
		
		// save number of windows
		this._number_of_windows = aState.windows.length;
		
		return this.JSON_encode(aState);
	},

	getFormattedName: function(aTitle, aDate, aFormat)
	{
		function cut(aString, aLength)
		{
			return aString.replace(new RegExp("^(.{" + (aLength - 3) + "}).{4,}$"), "$1...");
		}
		function toISO8601(aDate, format)
		{
			if (format) {
				return aDate.toLocaleFormat(format);
			}
			else {
				return [aDate.getFullYear(), pad2(aDate.getMonth() + 1), pad2(aDate.getDate())].join("-");
			}
		}
		function pad2(a) { return (a < 10)?"0" + a:a; }
		
		return (aFormat || this.mPref_name_format).split("%%").map(function(aPiece) {
			return aPiece.replace(/%(\d*)([tdm])(\"(.*)\")?/g, function($0, $1, $2, $3, $4) {
				$0 = ($2 == "t")?aTitle:($2 == "d")?toISO8601(aDate, $4):pad2(aDate.getHours()) + ":" + pad2(aDate.getMinutes());
				return ($1)?cut($0, Math.max(parseInt($1), 3)):$0;
			});
		}).join("%");
	},

	makeFileName: function(aString)
	{
		// Make sure we don't replace spaces with _ in filename since tabs become spaces
		aString = aString.replace(/\t/g, " ");
		
		// Reserved File names under Windows so add a "_" to name if one of them is used
		if (INVALID_FILENAMES.indexOf(aString) != -1) aString += "_";
		
		// Don't allow illegal characters for Operating Systems:
		// NTFS - <>:"/\|*? or ASCII chars from 00 to 1F
		// FAT - ^
		// OS 9, OS X and Linux - :
		return aString.replace(/[<>:"\/\\|*?^\x00-\x1F]/g, "_").substr(0, 64) + SESSION_EXT;
//		return aString.replace(/[^\w ',;!()@&+=~\x80-\xFE-]/g, "_").substr(0, 64) + SESSION_EXT;
	},
	
	getMostRecentWindow: function(aType)
	{
		let window = null;
		if (Cc["@mozilla.org/thread-manager;1"].getService().isMainThread) {
			window = WINDOW_MEDIATOR_SERVICE.getMostRecentWindow(aType ? aType : null);
		}
		else {
			log("Sanity Check Failure: getMostRecentWindow() called from background thread - this would have caused a crash.", "EXTRA");
		}
		return window;
	},
	
	// This will return the window with the matching SessionStore __SSi value if it exists
	getWindowBySSI: function(window__SSi) 
	{
		let windows = this.getBrowserWindows();
		for (var i=0; i<windows.length; i++)
		{
			if (windows[i].__SSi == window__SSi)
				return windows[i];
		}
		return null;
	},
	
	getBrowserWindows: function()
	{
		let windowsEnum = WINDOW_MEDIATOR_SERVICE.getEnumerator("navigator:browser");
		let windows = [];
		
		while (windowsEnum.hasMoreElements())
		{
			windows.push(windowsEnum.getNext());
		}
		
		return windows;
	},
	
	updateAutoSaveSessions: function(aOldName, aNewName) 
	{
		let updateTitlebar = false;
		
		// auto-save session
		if (this.mPref__autosave_name == aOldName) 
		{
			log("updateAutoSaveSessions: autosave change: aOldName = " + aOldName + ", aNewName = " + aNewName, "DATA");
			// rename or delete?
			if (aNewName) {
				gPreferenceManager.set("_autosave_values", this.mergeAutoSaveValues(aNewName, this.mPref__autosave_group, this.mPref__autosave_time));
			}
			else {
				gPreferenceManager.set("_autosave_values","");
			}
			updateTitlebar = true;
		}
		
		// window sessions
		this.getBrowserWindows().forEach(function(aWindow) {
			if (aWindow.com.morac.gSessionManagerWindowObject && aWindow.com.morac.gSessionManagerWindowObject.__window_session_name && (aWindow.com.morac.gSessionManagerWindowObject.__window_session_name == aOldName)) { 
				log("updateAutoSaveSessions: window change: aOldName = " + aOldName + ", aNewName = " + aNewName, "DATA");
				aWindow.com.morac.gSessionManagerWindowObject.__window_session_name = aNewName;
				// delete
				if (!aNewName)
				{
					aWindow.com.morac.gSessionManagerWindowObject.__window_session_group = null;
					aWindow.com.morac.gSessionManagerWindowObject.__window_session_time = 0;
				}
				updateTitlebar = true;
			}
		}, this);
		
		// Update titlebars
		if (updateTitlebar) OBSERVER_SERVICE.notifyObservers(null, "sessionmanager:updatetitlebar", null);
	},

	doResumeCurrent: function()
	{
		return (gPreferenceManager.get("browser.startup.page", 1, true) == 3)?true:false;
	},

	isCleanBrowser: function(aBrowser)
	{
		return aBrowser.sessionHistory.count < 2 && aBrowser.currentURI.spec == "about:blank";
	},

	setDisabled: function(aObj, aValue)
	{
		if (aValue)
		{
			aObj.setAttribute("disabled", "true");
		}
		else
		{
			aObj.removeAttribute("disabled");
		}
	},

	_string: function(aName)
	{
		return SM_BUNDLE.GetStringFromName(aName);
	},

	// Decode JSON string to javascript object - use JSON if built-in.
	JSON_decode: function(aStr, noError) {
		let jsObject = { windows: [{ tabs: [{ entries:[] }], selected:1, _closedTabs:[] }], _JSON_decode_failed:true };
		try {
			let hasParens = ((aStr[0] == '(') && aStr[aStr.length-1] == ')');
		
			// JSON can't parse when string is wrapped in parenthesis
			if (hasParens) {
				aStr = aStr.substring(1, aStr.length - 1);
			}
		
			// Session Manager 0.6.3.5 and older had been saving non-JSON compiant data so try to use evalInSandbox if JSON parse fails
			try {
				jsObject = NATIVE_JSON.decode(aStr);
			}
			catch (ex) {
				if (/[\u2028\u2029]/.test(aStr)) {
					aStr = aStr.replace(/[\u2028\u2029]/g, function($0) {"\\u" + $0.charCodeAt(0).toString(16)});
				}
				jsObject = Cu.evalInSandbox("(" + aStr + ")", new Cu.Sandbox("about:blank"));
			}
		}
		catch(ex) {
			jsObject._JSON_decode_error = ex;
			if (!noError) this.sessionError(ex);
		}
		return jsObject;
	},
	
	// Encode javascript object to JSON string - use JSON if built-in.
	JSON_encode: function(aObj) {
		let jsString = null;
		try {
			jsString = NATIVE_JSON.encode(aObj);
			// Needed until Firefox bug 387859 is fixed or else Firefox won't except JSON strings with \u2028 or \u2029 characters
			if (/[\u2028\u2029]/.test(jsString)) {
				jsString = jsString.replace(/[\u2028\u2029]/g, function($0) {"\\u" + $0.charCodeAt(0).toString(16)});
			}
		}
		catch(ex) {
			this.sessionError(ex);
		}
		return jsString;
	},
};

// String.trim is not defined in Firefox 3.0, so define it here if it isn't already defined.
if (typeof(String.trim) != "function") {
	String.prototype.trim = function() {
		return this.replace(/^\s+|\s+$/g, "");
	};
}
