var gSessionManager_preferencesOverlay = {
	init: function() {
        window.removeEventListener("load", arguments.callee, false);
		
		// BrowserPreferences = Firefox, prefDialog = SeaMonkey
		var prefWindow = document.getElementById('BrowserPreferences') || document.getElementById('prefDialog');
		if (prefWindow)
		{
			// Add event handlers for when panes load in Firefox
			var paneMain = document.getElementById('paneMain');
			if (paneMain) paneMain.addEventListener("paneload", gSessionManager_preferencesOverlay.onPaneLoad_proxy, false);

			var panePrivacy = document.getElementById('panePrivacy');
			if (panePrivacy) panePrivacy.addEventListener("paneload", gSessionManager_preferencesOverlay.onPaneLoad_proxy, false);
			
			// Add event handlers for SeaMonkey
			var browserPane = document.getElementById('navigator_pane');
	    	if (browserPane) browserPane.addEventListener("paneload", gSessionManager_preferencesOverlay.onPaneLoad_proxy, false);
			
			var securityPane = document.getElementById('security_pane');
	    	if (securityPane) securityPane.addEventListener("paneload", gSessionManager_preferencesOverlay.onPaneLoad_proxy, false);
			
			// Handle case if pane is already loaded when option window opens.
	    	gSessionManager_preferencesOverlay.onPaneLoad(prefWindow.lastSelected);
	    }
	},
	
	onPaneLoad_proxy: function (aEvent) {
		gSessionManager_preferencesOverlay.onPaneLoad(aEvent.target.id);
		//aEvent.target.removeEventListener("paneload", arguments.callee, false);
	},
	
	onPaneLoad: function (aPaneID) {
		var elem = document.getElementById(aPaneID);
		elem.removeEventListener("paneload", gSessionManager_preferencesOverlay.onPaneLoad_proxy, false);
		switch (aPaneID) {
			case "paneMain":
			case "navigator_pane":
				this.onPaneMainLoad();
				break;
			case "panePrivacy":
			case "security_pane":
				this.onPanePrivacyLoad(aPaneID);
				break;
		}
	},

/* ........ paneMain .............. */
	onPaneMainLoad: function (aPaneID) {
		var stringBundle = Components.classes["@mozilla.org/intl/stringbundle;1"]
		                   .getService(Components.interfaces.nsIStringBundleService)
		                   .createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
		
		// Firefox = browserStartupPage, SeaMonkey = startupPage
		var startMenu = document.getElementById("browserStartupPage") || document.getElementById("startupPage");
		var height = 0;
		if (startMenu) {
			var menuitem = startMenu.appendItem(stringBundle.GetStringFromName("startup_load"), gSessionManager.STARTUP_LOAD());
			height = height + parseInt(window.getComputedStyle(menuitem, null).height);
			if (startMenu.value == gSessionManager.STARTUP_LOAD()) startMenu.selectedItem = menuitem;
			menuitem = startMenu.appendItem(stringBundle.GetStringFromName("startup_prompt"), gSessionManager.STARTUP_PROMPT());
			height = height + parseInt(window.getComputedStyle(menuitem, null).height);
			if (startMenu.value == gSessionManager.STARTUP_PROMPT()) startMenu.selectedItem = menuitem;
		}
		
		// SeaMonkey needs window size to be fixed since the radio buttons take up space
		if (document.getElementById("startupPage")) {
			if (!isNaN(height)) window.innerHeight = window.innerHeight + height;
		}
   },

/* ........ panePrivacy .............. */

	onPanePrivacyLoad: function (aPaneID)	{
   	    var clearNowBn = document.getElementById("clearDataNow");
   	    if (clearNowBn && clearNowBn.getAttribute("oncommand").indexOf("gSessionManager") == -1) { 
   	        clearNowBn.setAttribute("oncommand", "gSessionManager.tryToSanitize(); " + clearNowBn.getAttribute("oncommand"));
			// SeaMonkey needs to have Session Manager added directly to preferences window
			if (aPaneID == "security_pane") {
				gSessionManager.addMenuItem(aPaneID);
			}
        }
    }
}

// Attach sanitizing functions to gSessionManager
gSessionManager.onLoad = function() {
}

gSessionManager.onUnload = function() {
}

gSessionManager.addSanitizeItem = function () {
	window.removeEventListener('load', gSessionManager.addSanitizeItem, true);
	
	var sessionManagerItem = {
		clear : function() {
			try {
				gSessionManager.sanitize();
			} catch (ex) {
				try { Components.utils.reportError(ex); } catch(ex) {}
			}
		},
		get canClear() {
			return true;
		}
	}
		
	// Firefox
	if (typeof Sanitizer == 'function') {
		// Sanitizer will execute this
		Sanitizer.prototype.items['extensions-sessionmanager'] = sessionManagerItem;
	}
	// SeaMonkey
	else if (typeof Sanitizer == 'object') {
		// Sanitizer will execute this
		Sanitizer.items['extensions-sessionmanager'] = sessionManagerItem;
	}
	
	// don't leak
	sessionManagerItem = null;
}

gSessionManager.addMenuItem = function (aPaneID) {
	var isSeaMonkey = aPaneID == "security_pane";
	var doc = isSeaMonkey ? document.getElementById(aPaneID) : document;
	var prefs = doc.getElementsByTagName('preferences')[0];
	var checkboxes = doc.getElementsByTagName('checkbox')
	var listboxes = doc.getElementsByTagName('listitem');
	var lastCheckbox = (checkboxes.length) ? checkboxes[checkboxes.length -1] : null;
	var lastListbox = (listboxes.length) ? listboxes[listboxes.length -1] : null;
	if (prefs && (lastCheckbox || lastListbox)) // if this isn't true we are lost :)
	{

		// Determine Mozilla version to see what is supported
		var appVersion = "0";
		try {
			appVersion = Components.classes["@mozilla.org/xre/app-info;1"].
			             getService(Components.interfaces.nsIXULAppInfo).platformVersion;
		} catch (e) { dump(e + "\n"); }
		
		var pref = document.createElement('preference');
		// Firefox 3.5 and above only
		if ((appVersion >= "1.9.1") && (window.location == "chrome://browser/content/sanitize.xul")) {
			this.mSanitizePreference = "privacy.cpd.extensions-sessionmanager";
		}
		pref.setAttribute('id', this.mSanitizePreference);
		pref.setAttribute('name', this.mSanitizePreference);
		pref.setAttribute('type', 'bool');
		prefs.appendChild(pref);

		if (lastListbox) {
			var listitem = document.createElement('listitem');
			listitem.setAttribute('label', this.sanitizeLabel.label);
			listitem.setAttribute('type', 'checkbox');
			listitem.setAttribute('accesskey', this.sanitizeLabel.accesskey);
			listitem.setAttribute('preference', this.mSanitizePreference);
			lastListbox.parentNode.appendChild(listitem);
		}
		else if (lastCheckbox) {
			var check = document.createElement('checkbox');
			check.setAttribute('label', this.sanitizeLabel.label);
			check.setAttribute('accesskey', this.sanitizeLabel.accesskey);
			check.setAttribute('preference', this.mSanitizePreference);
			
			if (lastCheckbox.parentNode.localName == "row") {
				var newRow = document.createElement('row');
				newRow.appendChild(check);
				lastCheckbox.parentNode.parentNode.appendChild(newRow);
			}
			else {
				lastCheckbox.parentNode.appendChild(check);
			}
		}

		// Firefox only
		if (typeof(gSanitizePromptDialog) == 'object')
		{
			if (appVersion < "1.9.1") pref.setAttribute('readonly', 'true');
			check.setAttribute('onsyncfrompreference', 'return gSanitizePromptDialog.onReadGeneric();');
		}
		
		// SeaMonkey needs to sync preference when display pref window
		if (isSeaMonkey) pref.updateElements();
	}
}

gSessionManager.tryToSanitize = function () {
	var prefService = Components.classes["@mozilla.org/preferences-service;1"]
						.getService(Components.interfaces.nsIPrefBranch);
	try {
		var promptOnSanitize = prefService.getBoolPref("privacy.sanitize.promptOnSanitize");
	} catch (e) { promptOnSanitize = true;}

	// if promptOnSanitize is true we call gSessionManager_Sanitizer.sanitize from Firefox Sanitizer
	if (promptOnSanitize)
		return false;

	try {
		var sanitizeSessionManager = prefService.getBoolPref("privacy.item.extensions-sessionmanager");
	} catch (e) { sanitizeSessionManager = false;}

	if (!sanitizeSessionManager)
		return false;

	gSessionManager.sanitize();
	return true;
}

window.addEventListener("load", gSessionManager_preferencesOverlay.init, false);
