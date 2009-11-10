// Configuration Constant Settings - addon specific
const ADDON_NAME = "Session Manager";
const FILE_NAME = "sessionmanager_log.txt";
const LOG_ENABLE_PREFERENCE_NAME = "extensions.sessionmanager.logging";
const LOG_LEVEL_PREFERENCE_NAME = "extensions.sessionmanager.logging_level";
const BUNDLE_URI = "chrome://sessionmanager/locale/sessionmanager.properties";
const ERROR_STRING_NAME = "file_not_found";

const Cc = Components.classes;
const Ci = Components.interfaces
const report = Components.utils.reportError;

// Get and store services
var mPromptService = Cc["@mozilla.org/embedcomp/prompt-service;1"].getService(Ci.nsIPromptService);
var mConsoleService = Cc['@mozilla.org/consoleservice;1'].getService(Ci.nsIConsoleService);
var Application = (Cc["@mozilla.org/fuel/application;1"]) ? Cc["@mozilla.org/fuel/application;1"].getService(Ci.fuelIApplication) :  
                   ((Cc["@mozilla.org/smile/application;1"]) ? Cc["@mozilla.org/smile/application;1"].getService(Ci.smileIApplication) : null);

var EXPORTED_SYMBOLS = ["log", "logError", "deleteLogFile", "openLogFile", "logging_level"];

// logging level
var logging_level = {};
logging_level["STATE"] = 1;
logging_level["TRACE"] = 2;
logging_level["DATA"] = 4;
logging_level["INFO"] = 8;
logging_level["EXTRA"] = 16;
logging_level["ERROR"] = 32;

// private variables
var _EOL = null;				// End of Line character - set once a window exists
var _initialized = false;		// Logger module initialized
var _logFile = null;			// Current log file
var _logged_Addons = false;		// Set to true, when the current enabled add-ons have been logged (once per browsing session)
var _logEnabled = false;		// Set to true if logging is enabled
var _logLevel = 0;				// Set to the current logging level (see above)
var _printedHeader = false;		// Printed header to log file

// 
// Public Logging functions
//

//
// Utility to create an error message in the log without throwing an error.
//
function logError(e, force) {
	// If not an exception, just log it.
	if (!e.message) {
		log(e, force);
		return;
	}
	
	// Initialize if not already done
	if (!_initialized) {
		initialize();
	
		// If couldn't initialize preferences, return
		if (!_initialized) return;
	}
	
	// Log Addons if haven't already and EOL character exists
	if (!_logged_Addons && _EOL) logExtensions();
		
	try { 
		if (force || _logEnabled) {
			mConsoleService.logStringMessage(ADDON_NAME + " (" + (new Date).toGMTString() + "): {" + e.message + "} {" + e.location + "}");
			write_log((new Date).toGMTString() + ": {" + e.message + "} {" + e.location + "}" + "\n");
		}
	}
	catch (ex) {
		report(ex);
	}
}

//
// Log info messages
//
function log(aMessage, level, force) {
	// Initialize if not already done
	if (!_initialized) {
		initialize();
	
		// If couldn't initialize preferences, return
		if (!_initialized) return;
	}

	// Log Addons if haven't already and EOL character exists
	if (!_logged_Addons && _EOL) logExtensions();

	if (!level) level = "INFO";
	try {
		if (force || (_logEnabled && (logging_level[level] & _logLevel))) {
			mConsoleService.logStringMessage(ADDON_NAME + " (" + (new Date).toGMTString() + "): " + aMessage);
			write_log((new Date).toGMTString() + ": " + aMessage + "\n");
		}
	}
	catch (ex) { 
		report(ex); 
	}
}

// 
// Delete Log File if it exists and not logging or it's too large (> 10 MB)
//
function deleteLogFile(aForce) {
	// If log file not stored, store it.  This will throw an exception if the profile hasn't been initialized so just exit in that case.
	if (!_logFile) {
		if (!setLogFile()) return false;
	}
	
	try { 
		if (_logFile.exists() && (aForce || !_logEnabled || _logFile.fileSize > 10485760)) {
			_logFile.remove(false);
			return true;
		}
	}
	catch (ex) { 
		report(ex); 
	}
	return true;
}

//
// Open Log File
//
function openLogFile() {
	// Report error if log file not found
	if (!_logFile || !_logFile.exists() || !(_logFile instanceof Ci.nsILocalFile)) {
		try {
			let bundle = Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService).createBundle(BUNDLE_URI);
			let errorString = bundle.GetStringFromName(ERROR_STRING_NAME);	
			mPromptService.alert(null, ADDON_NAME, errorString);
		}
		catch (ex) {
			report(ex);
		}
		return;
	}
		
	try {
		// "Double click" the log file to open it
		_logFile.launch();
	} catch (e) {
		try {
			// If launch fails (probably because it's not implemented), let the OS handler try to open the log file
			let mimeInfoService = Cc["@mozilla.org/uriloader/external-helper-app-service;1"].getService(Ci.nsIMIMEService);
			let mimeInfo = mimeInfoService.getFromTypeAndExtension(mimeInfoService.getTypeFromFile(_logFile), "txt");
			mimeInfo.preferredAction = mimeInfo.useSystemDefault;
			mimeInfo.launchWithFile(_logFile);      
		}
		catch (ex)
		{
			mPromptService.alert(null, ADDON_NAME, ex);
		}
	}
}
	

//
// Private Functions
//


//
// Set the Log File - This will throw if profile isn't lodaed yet
//
function setLogFile() {
	if (!_logFile) {
		try {
			// Get Profile folder and append log file name
			_logFile = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfD", Ci.nsILocalFile).clone();
			_logFile.append(FILE_NAME);
		}
		catch (ex) { 
			_logFile = null;
			return false;
		}
	}
	return true;
}

//
// Write to Log File
// 
function write_log(aMessage) {
	// If log file not stored, store it.  This will throw an exception if the profile hasn't been initialized so just exit in that case.
	if (!_logFile) {
		if (!setLogFile()) return;
	}
	
	// If EOL character isn't stored, try to get it
	if (!_EOL) {
		// Try to get the most recent window to find the platform
		let recentWindow = Components.classes["@mozilla.org/appshell/window-mediator;1"].getService(Components.interfaces.nsIWindowMediator).getMostRecentWindow(null);
		let platform = (recentWindow ? recentWindow.navigator.platform : null);

		if (platform) {
			// Set EOL character
			_EOL = /win|os[\/_]?2/i.test(platform)?"\r\n":/mac/i.test(platform)?"\r":"\n";
		}
	}
	
	try {
		let stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
		// ioFlags: write only, create file, append;	Permission: read/write owner
		stream.init(_logFile, 0x02 | 0x08 | 0x10, 0600, 0);
		let cvstream = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
		cvstream.init(stream, "UTF-8", 0, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);

		if (!_printedHeader) {
			let EOL = (_EOL ? _EOL : "\n");
			cvstream.writeString(EOL + "*************************************************" + EOL);
			cvstream.writeString("******** B R O W S E R   S T A R T U P **********" + EOL);
			cvstream.writeString("*************************************************" + EOL);
			_printedHeader = true;
		}
		cvstream.writeString(aMessage.replace(/[\n$]/g, (_EOL ? _EOL : "\n")));
		cvstream.flush();
		cvstream.close();
	}
	catch (ex) { 
		report(ex); 
	}
}
	
//
// Log Extensions - Also log browser version
//
function logExtensions() {
	if (!_logEnabled) return;
	_logged_Addons = true;

	if (!Application) return;
		
	// Log browser version
	log("Browser = " + Application.id + " - " + Application.name + " " + Application.version, "INFO");
	
	// Log Addons
	let extensions = Application.extensions.all;
	if (extensions.length) {
		log("Extensions installed and enabled:");
		for (let i=0; i<extensions.length; i++) {
			if (extensions[i].enabled) {
				log(extensions[i].name + " " + extensions[i].version, "INFO");
			}
		}
	}
}

// Handle logging preference changes
function preferenceChanged(event) {
	if (event.type == "change") {
		switch (event.data) {
			case LOG_ENABLE_PREFERENCE_NAME:
				_logEnabled = Application.prefs.get(LOG_ENABLE_PREFERENCE_NAME).value;
				break;
			case LOG_LEVEL_PREFERENCE_NAME:
				_logLevel = Application.prefs.get(LOG_LEVEL_PREFERENCE_NAME).value;
				break;
		}
	}
}

function initialize() {
	// Only initialize in the main thread
	if (!Cc["@mozilla.org/thread-manager;1"].getService().isMainThread) return;

	var enabledPref = Application.prefs.get(LOG_ENABLE_PREFERENCE_NAME);
	var levelPref = Application.prefs.get(LOG_LEVEL_PREFERENCE_NAME);
	
	if (enabledPref) {
		_logEnabled = enabledPref.value;
		enabledPref.events.addListener("change", preferenceChanged);
	}
	if (levelPref) {
		_logLevel = levelPref.value;
		levelPref.events.addListener("change", preferenceChanged);
	}
	
	// If preferences exist
	if (enabledPref && levelPref) {
		// Do a conditional delete of the log file each time the application starts
		deleteLogFile();
	
		_initialized = true;
	}
}
