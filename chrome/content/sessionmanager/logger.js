gSessionManager.logFileName = "sessionmanager_log.txt";

//
// Utility to create an error message in the log without throwing an error.
//
gSessionManager.logError = function(e, force) {
	try { 
		if (force || this.getPref("debug", false)) {
			var consoleService = Components.classes['@mozilla.org/consoleservice;1'].getService(Components.interfaces.nsIConsoleService);
			var consoleError = Components.classes['@mozilla.org/scripterror;1'].createInstance(Components.interfaces.nsIScriptError);

			consoleError.init(e.message, e.fileName, e.lineNumber, e.lineNumber, e.columnNumber, 0, null);

			consoleService.logStringMessage("Session Manager (" + (new Date).toGMTString() + "): " + consoleError.toString());
			this.write_log((new Date).toGMTString() + "): " + consoleError + "\n");
		}
	}
	catch (ex) {
		dump (ex + "\n")
	}
}

//
// Log info messages
//
gSessionManager.log = function(aMessage, force) {
	try {
		if (force || this.getPref("debug", false)) {
			var consoleService = Components.classes['@mozilla.org/consoleservice;1'].getService(Components.interfaces.nsIConsoleService);
			consoleService.logStringMessage("Session Manager (" + (new Date).toGMTString() + "): " + aMessage);
			this.write_log((new Date).toGMTString() + "): " + aMessage + "\n");
		}
	}
	catch (ex) { 
		dump(ex + "\n"); 
	}
}

//
// Open Log File
//
gSessionManager.openLogFile = function() {
	var logFile = this.getProfileFile(this.logFileName);
	if (!logFile.exists() || !(logFile instanceof Components.interfaces.nsILocalFile)) return;
	try {
		// "Double click" the log file to open it
		logFile.launch();
	} catch (e) {
		try {
			// If launch fails (probably because it's not implemented), let the OS handler try to open the log file
			var mimeInfoService = Components.classes["@mozilla.org/uriloader/external-helper-app-service;1"].getService(Components.interfaces.nsIMIMEService);
			var mimeInfo = mimeInfoService.getFromTypeAndExtension(mimeInfoService.getTypeFromFile(logFile), "txt");
			mimeInfo.preferredAction = mimeInfo.useSystemDefault;
			mimeInfo.launchWithFile(logFile);      
		}
		catch (ex)
		{
			this.ioError(ex);
		}
	}
}

// 
// Delete Log File if it exists and not logging or it's too large (> 1 MB)
//
gSessionManager.deleteLogFile = function(aForce) {
	try { 
		var logFile = this.getProfileFile(this.logFileName);

		if (logFile.exists() && (aForce || !this.getPref("debug", false) || logFile.fileSize > 1048576)) {
			logFile.remove(false);
		}
	}
	catch (ex) { 
		dump(ex + "\n"); 
	}
}
				 
//
// Write to Log File
// 
gSessionManager.write_log = function(aMessage) {
	try {
		var logFile = this.getProfileFile(this.logFileName);

		var stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
		// ioFlags: write only, create file, append;	Permission: read/write owner
		stream.init(logFile, 0x02 | 0x08 | 0x10, 0600, 0);
		var cvstream = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
		cvstream.init(stream, "UTF-8", 0, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);

		cvstream.writeString(aMessage.replace(/[\n$]/g, this.mEOL));
		cvstream.flush();
		cvstream.close();
	}
	catch (ex) { 
		dump(ex + "\n"); 
	}
}
	