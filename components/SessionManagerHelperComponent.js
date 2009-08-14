/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Michael Kraft.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */
const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const report = Components.utils.reportError;

const STARTUP_PROMPT = -11;
const BROWSER_STARTUP_PAGE_PREFERENCE = "browser.startup.page";
const OLD_BROWSER_STARTUP_PAGE_PREFERENCE = "extensions.sessionmanager.old_startup_page";
const SM_STARTUP_PREFERENCE = "extensions.sessionmanager.startup";
const SM_SESSIONS_DIR_PREFERENCE = "extensions.sessionmanager.sessions_dir";
const SM_TEMP_RESTORE_PREFERENCE = "extensions.sessionmanager.temp_restore";

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

function SessionManagerHelperComponent() {
	try {
		// import logger
		Cu.import("resource://sessionmanager/modules/logger.js", this);
	}
	catch (ex) {
		report(ex);
	}
}

SessionManagerHelperComponent.prototype = {
	// registration details
	classDescription: "Session Manager Helper Component",
	classID:          Components.ID("{5714d620-47ce-11db-b0de-0800200c9a66}"),
	contractID:       "@morac/sessionmanager-helper;1",
	_xpcom_categories: [{ category: "app-startup", service: true },
	                    { category: "command-line-handler", entry: "sessionmanager" }],
	_ignorePrefChange: false,
	_sessionExt: ".session",
	mAutoPrivacy: false,
	mBackupState: null,
	mSessionData: null,
	
	// interfaces supported
	QueryInterface: XPCOMUtils.generateQI([Ci.nsISessionManangerHelperComponent, Ci.nsIObserver, Ci.nsICommandLineHandler]),

	/* nsICommandLineHandler */
	handle : function clh_handle(cmdLine)
	{
		// Find and remove the *.session command line argument and save it to a preference
		try {
			for (let i=0; i<cmdLine.length; i++) {
				let name = cmdLine.getArgument(i);
				if (/^.*\.session$/.test(name)) {
					var file = this.getSessionDir(name);
					if (file.exists()) {
						cmdLine.removeArguments(i,i);
						let pb = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
						let str = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
						str.data = name;
						pb.setComplexValue(SM_TEMP_RESTORE_PREFERENCE,Ci.nsISupportsString, str);
						break;
					}
				}
			}
		}
		catch (ex) {
			report("Session Manager: Command Line Error - " + ex);
		}
	},
	
	log: function(aMsg, aLevel, aForce)
	{
		try {
			if ((typeof(this.logger) == "function") && this.logger()) {
				this.logger().log(aMsg, aLevel, aForce);
			}
		}
		catch (ex) {
			report(ex);
		}
	},
	
	// observer
	observe: function(aSubject, aTopic, aData)
	{
		let os = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
		let pb = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch2);
		
		this.log("SessionManagerHelperComponent observer: aTopic = " + aTopic + ", aData = " + aData + ", Subject = " + aSubject, "INFO");
		switch (aTopic)
		{
		case "app-startup":
			os.addObserver(this, "private-browsing-change-granted", false);
			os.addObserver(this, "profile-after-change", false);
			os.addObserver(this, "final-ui-startup", false);
			os.addObserver(this, "sessionstore-state-read", false);
			os.addObserver(this, "sessionstore-windows-restored", false);
			os.addObserver(this, "profile-change-teardown", false);
			break;
		case "private-browsing-change-granted":
			switch(aData) {
			case "enter":
				try {
					let ss = Cc["@mozilla.org/browser/sessionstore;1"] || Cc["@mozilla.org/suite/sessionstore;1"];
					this.mBackupState = ss.getService(Ci.nsISessionStore).getBrowserState();
					this.mAutoPrivacy = Cc["@mozilla.org/privatebrowsing;1"].getService(Ci.nsIPrivateBrowsingService).autoStarted;
				}
				catch(ex) { 
					report(ex); 
				}
				break;
			case "exit":
				aSubject.QueryInterface(Ci.nsISupportsPRBool);
				// If browser not shutting down, clear the backup state otherwise leave it to be read by sessionmanager.js
				if (!aSubject.data) {
					this.mBackupState = null;
				}
				break;
			}
			break;
		case "profile-after-change":
			os.removeObserver(this, aTopic);
			try
			{
				this._restoreCache();
			}
			catch (ex) { report(ex); }
			break;
		case "final-ui-startup":
			os.removeObserver(this, aTopic);
			try
			{
				this._handle_crash();
			}
			catch (ex) { report(ex); }
			
			// stuff to handle preference file saving
			this.mTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
			os.addObserver(this, "quit-application-granted", false);
			os.addObserver(this, "sessionmanager-preference-save", false);
			os.addObserver(this, "sessionmanager:restore-startup-preference", false);
			os.addObserver(this, "sessionmanager:ignore-preference-changes", false);
			
			// Observe startup preference
			pb.addObserver(BROWSER_STARTUP_PAGE_PREFERENCE, this, false);
			break;
		case "sessionstore-windows-restored":
			os.removeObserver(this, aTopic);
			try 
			{
				// Tell the browser windows that the initial session has been restored
				// Do this here so we don't have to add an observer to every window that opens which is
				// pointless since this only fires at browser startup
				os.notifyObservers(null, "sessionmanager:initial-windows-restored", null);
			}
			catch (ex) { report(ex); }
			break;
		case "sessionstore-state-read":
			os.removeObserver(this, aTopic);
			try 
			{
				this._check_for_crash(aSubject);
			}
			catch (ex) { report(ex); }
			break;
		case "sessionmanager-preference-save":
			// Save preference file after one 1/4 second to delay in case another preference changes at same time as first
			this.mTimer.cancel();
			this.mTimer.initWithCallback({
				notify:function (aTimer) { Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefService).savePrefFile(null); }
			}, 250, Ci.nsITimer.TYPE_ONE_SHOT);
			break;
		case "sessionmanager:restore-startup-preference":
			os.removeObserver(this, aTopic);
			this._ignorePrefChange = true;
			try 
			{
				// Restore browser startup preference if Session Manager previously saved it, otherwise backup current browser startup preference
				if (pb.prefHasUserValue(OLD_BROWSER_STARTUP_PAGE_PREFERENCE)) {
					pb.setIntPref(BROWSER_STARTUP_PAGE_PREFERENCE, pb.getIntPref(OLD_BROWSER_STARTUP_PAGE_PREFERENCE));
				}
				else {
					pb.setIntPref(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, pb.getIntPref(BROWSER_STARTUP_PAGE_PREFERENCE));
				}
			}
			catch (ex) { report(ex); }
			this._ignorePrefChange = false;
			break;
		case "sessionmanager:ignore-preference-changes":
			this._ignorePrefChange = (aData == "true");
			break;
		case "quit-application-granted":
			os.removeObserver(this, "sessionmanager-preference-save");
			os.removeObserver(this, aTopic);
			
			// Remove preference observer
			pb.removeObserver(BROWSER_STARTUP_PAGE_PREFERENCE, this);
			break;
		case "profile-change-teardown":
			let page = pb.getIntPref(BROWSER_STARTUP_PAGE_PREFERENCE);
			// If Session Manager is handling startup, save the current startup preference and then set it to home page
			// otherwise clear the saved startup preference
			if ((page == 3) && pb.getIntPref(SM_STARTUP_PREFERENCE)) {
				pb.setIntPref(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, page);
				pb.clearUserPref(BROWSER_STARTUP_PAGE_PREFERENCE);
			}
			else if (pb.prefHasUserValue(OLD_BROWSER_STARTUP_PAGE_PREFERENCE)) {
				pb.clearUserPref(OLD_BROWSER_STARTUP_PAGE_PREFERENCE);
			}
			break;
		case "nsPref:changed":
			switch(aData) 
			{
				case BROWSER_STARTUP_PAGE_PREFERENCE:
					// Handle case where user changes browser startup preference
					if (!this._ignorePrefChange) this._synchStartup();
					break;
			}
			break;
		}
	},

	/* ........ public methods ............... */

	// this will save the passed in session data into the mSessionData variable
	setSessionData: function sm_setSessionData(aState) 
	{
		this.mSessionData = aState;
	},

	/* ........ private methods .............. */

	// this will handle the case where user turned off crash recovery and browser crashed and
	// preference indicates there is an active session, but there really isn't
	_handle_crash: function sm_handle_crash()
	{
		let prefroot = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
		let sessionStartup = Cc["@mozilla.org/browser/sessionstartup;1"] || Cc["@mozilla.org/suite/sessionstartup;1"];
		if (sessionStartup) sessionStartup = sessionStartup.getService(Ci.nsISessionStartup);
		let resuming = (sessionStartup && sessionStartup.sessionType && (sessionStartup.sessionType != Ci.nsISessionStartup.NO_SESSION)) ||
		               prefroot.getBoolPref("browser.sessionstore.resume_session_once") || 
		               prefroot.getBoolPref("browser.sessionstore.resume_from_crash");

		let sm_running = (prefroot.getPrefType("extensions.sessionmanager._running") == prefroot.PREF_BOOL) && 
		                 prefroot.getBoolPref("extensions.sessionmanager._running");
		
		//dump("running = " + sm_running + "\nresuming = " + resuming + "\n");
		//report("running = " + sm_running + "\nresuming = " + resuming + "\n");
		if (sm_running && !resuming)
		{
			dump("SessionManager: Removing active session\n");
			prefroot.deleteBranch("extensions.sessionmanager._autosave_values");
			prefroot.deleteBranch("extensions.sessionmanager._running");
			prefroot.deleteBranch("extensions.sessionmanager._recovering");
			prefroot.deleteBranch("extensions.sessionmanager._encrypt_file");
		}
	},
	
	// This will check to see if there was a crash and if so put up the crash prompt 
	// to allow the user to choose a session to restore.  This is only called for Firefox 3.5 and up and SeaMonkey 2.0 and up
	_check_for_crash: function sm_check_for_crash(aStateDataString)
	{
		let initialState;
		try {
			// parse the session state into JS objects
			initialState = this.JSON_decode(aStateDataString.QueryInterface(Ci.nsISupportsString).data);
		}
		catch (ex) { 
			report("The startup session file is invalid: " + ex); 
			return;
		} 
    
		let lastSessionCrashed =
			initialState && initialState.session && initialState.session.state &&
			initialState.session.state == "running";
		
		//report("Last Crashed = " + lastSessionCrashed);
		if (lastSessionCrashed) {
        	let params = Cc["@mozilla.org/embedcomp/dialogparam;1"].createInstance(Ci.nsIDialogParamBlock);
        	// default to recovering
        	params.SetInt(0, 0);
        	Cc["@mozilla.org/embedcomp/window-watcher;1"].getService(Ci.nsIWindowWatcher).
        		openWindow(null, "chrome://sessionmanager/content/restore_prompt.xul", "_blank", "chrome,modal,centerscreen,titlebar", params);
        	if (params.GetInt(0) == 1) aStateDataString.QueryInterface(Ci.nsISupportsString).data = "";
        	else if (initialState.session) {
	        	// don't prompt for tabs if checkbox not checked
	        	delete(initialState.session.lastUpdate);
	        	delete(initialState.session.recentCrashes);
	        	aStateDataString.QueryInterface(Ci.nsISupportsString).data = this.JSON_encode(initialState);
        	}
    	}
    	initialState = null;
	},

	// code adapted from Danil Ivanov's "Cache Fixer" extension
	_restoreCache: function sm_restoreCache()
	{
    	let cache = null;
		try 
		{
			let prefroot = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
			let disabled = prefroot.getBoolPref("extensions.sessionmanager.disable_cache_fixer");
			if (disabled)
			{
				let consoleService = Cc["@mozilla.org/consoleservice;1"].getService(Ci.nsIConsoleService);
  				consoleService.logStringMessage("SessionManager: Cache Fixer disabled");
				return;
			}
			let pd_path = prefroot.getComplexValue("browser.cache.disk.parent_directory",Ci.nsISupportsString).data;
			cache = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
			cache.initWithPath(pd_path);
		}
		catch (ex) {}
		
		if (!cache) cache = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfLD", Ci.nsILocalFile);
		cache.append("Cache");
		cache.append("_CACHE_MAP_");
		if (!cache.exists())
		{
			return;
		}
		
		let stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
		stream.init(cache, 0x01, 0, 0); // PR_RDONLY
		let input = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
		input.setInputStream(stream);
		let content = input.readByteArray(input.available());
		input.close();
		
		if (content[15] != 1)
		{
			return;
		}
		content[15] = 0;
		
		stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
		stream.init(cache, 0x02 | 0x20, 0600, 0); // PR_WRONLY | PR_TRUNCATE
		let output = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
		output.setOutputStream(stream);
		output.writeByteArray(content, content.length);
		output.flush();
		output.close();
	},

	// Make sure that the browser and Session Manager are on the same page with regards to the startup preferences
	_synchStartup: function sm_synchStartup()
	{
		let pb = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
		let browser_startup = pb.getIntPref(BROWSER_STARTUP_PAGE_PREFERENCE);
		let sm_startup = pb.getIntPref(SM_STARTUP_PREFERENCE);
		//dump("page:" + browser_startup + ", startup:" + sm_startup + "\n");

		// Ignore any preference changes made in this function
		this._ignorePrefChange = true;
		
		// If browser handling startup, disable Session Manager startup and backup startup page
		// otherwise set Session Manager to handle startup and restore browser startup setting
		if (browser_startup > STARTUP_PROMPT) {
			pb.setIntPref(SM_STARTUP_PREFERENCE, 0);
			pb.setIntPref(OLD_BROWSER_STARTUP_PAGE_PREFERENCE, browser_startup);
		}
		else {
			pb.setIntPref(SM_STARTUP_PREFERENCE, (browser_startup == STARTUP_PROMPT) ? 1 : 2);
			pb.setIntPref(BROWSER_STARTUP_PAGE_PREFERENCE, pb.getIntPref(OLD_BROWSER_STARTUP_PAGE_PREFERENCE));
		}

		// Resume listening to preference changes
		this._ignorePrefChange = false;
	},

	// Get the profile dir
	getProfileFile: function getProfileFile(aFileName)
	{
		let file = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfD", Ci.nsILocalFile).clone();
		file.append(aFileName);
		return file;
	},
	
	// Get the user specific sessions directory
	getUserDir: function getUserDir(aFileName)
	{
		let dir = null;
		let dirname = null;

		try {
			let pb = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
			dirname = pb.getComplexValue(SM_SESSIONS_DIR_PREFERENCE,Ci.nsISupportsString).data;
			if (dirname) {
				let dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
				dir.initWithPath(dirname);
				if (dir.isDirectory && dir.isWritable()) {
					dir.append(aFileName);
				}
				else {
					dir = null;
				}
			}
		} catch (ex) {
			dir = null;
		} finally {
			return dir;
		}
	},

	// Get the sessions dir
	getSessionDir: function getSessionDir(aFileName, aUnique)
	{
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
				report("Session Manager: File Error - " + ex);
				return null;
			}
		}
		if (aFileName)
		{
			dir.append(aFileName);
			if (aUnique)
			{
				let postfix = 1, ext = "";
				if (aFileName.slice(-this._sessionExt.length) == this._sessionExt)
				{
					aFileName = aFileName.slice(0, -this._sessionExt.length);
					ext = this._sessionExt;
				}
				while (dir.exists())
				{
					dir = dir.parent;
					dir.append(aFileName + "-" + (++postfix) + ext);
				}
			}
		}
		return dir.QueryInterface(Ci.nsILocalFile);
	},
	
	// Decode JSON string to javascript object
	JSON_decode: function sm_JSON_decode(aStr) {
		let jsObject = { windows: [{ tabs: [{ entries:[] }], selected:1, _closedTabs:[] }], _JSON_decode_failed:true };
		try {
			let hasParens = ((aStr[0] == '(') && aStr[aStr.length-1] == ')');
		
			// JSON can't parse when string is wrapped in parenthesis
			if (hasParens) {
				aStr = aStr.substring(1, aStr.length - 1);
			}
		
			// Session Manager 0.6.3.5 and older had been saving non-JSON compiant data so try to use evalInSandbox if JSON parse fails
			try {
				jsObject = JSON.parse(aStr);
			}
			catch (ex) {
				if (/[\u2028\u2029]/.test(aStr)) {
					aStr = aStr.replace(/[\u2028\u2029]/g, function($0) {"\\u" + $0.charCodeAt(0).toString(16)});
				}
				jsObject = Cu.evalInSandbox("(" + aStr + ")", new Cu.Sandbox("about:blank"));
			}
		}
		catch(ex) {
			report("SessionManager: " + ex);
		}
		return jsObject;
	},
	
	// Encode javascript object to JSON string - use JSON if built-in.
	JSON_encode: function sm_JSON_encode(aObj) {
		let jsString = null;
		try {
			jsString = JSON.stringify(aObj);
			// Workaround for Firefox bug 485563
			if (/[\u2028\u2029]/.test(jsString)) {
				jsString = jsString.replace(/[\u2028\u2029]/g, function($0) {"\\u" + $0.charCodeAt(0).toString(16)});
			}
		}
		catch(ex) {
			report("SessionManager: " + ex);
		}
		return jsString;
	},
};

// Register Component
function NSGetModule(compMgr, fileSpec) {
  return XPCOMUtils.generateModule([SessionManagerHelperComponent]);
}