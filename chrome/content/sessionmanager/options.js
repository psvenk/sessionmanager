gSessionManager._onLoad = gSessionManager.onLoad;
gSessionManager.onLoad = function() {
	this._onLoad(true);
	
	// Populate select session list and select previously selected session
	var resume_session = _("resume_session");
	var sessions = this.getSessions();
	resume_session.appendItem(this._string("startup_resume"), this.mBackupSessionName, "");
	sessions.forEach(function(aSession) {
		if ((aSession.fileName != this.mAutoSaveSessionName) && (aSession.fileName != this.mBackupSessionName))
		{
			resume_session.appendItem(aSession.name, aSession.fileName, "");
		}
	}, this);
	// if no restore value, select previous browser session
	resume_session.value = _("extensions.sessionmanager.resume_session").value || this.mBackupSessionName;
	
	// current load session no longer there
	if (resume_session.selectedIndex == -1) {
		resume_session.value ="";
		_("extensions.sessionmanager.resume_session").valueFromPreferences = resume_session.value;
		// change option to none if select session was selected
		if (_("startupOption").selectedIndex==2) {
			_("startupOption").selectedIndex = 0;
			_("extensions.sessionmanager.startup").valueFromPreferences = _("startupOption").selectedIndex;
		}
	}
	
	// Restore selected indexes and hide/show menus for startup options
	_("generalPrefsTab").selectedIndex = _("extensions.sessionmanager.options_selected_tab").valueFromPreferences;
	startupSelect(_("startupOption").selectedIndex = _("extensions.sessionmanager.startup").valueFromPreferences);
	
	// Hide close tab restoration preferences in SeaMonkey since it doesn't work
	if (this.mAppID == "SEAMONKEY") {
		_("save_closed_tabs").parentNode.style.visibility = "collapse";
	}
	
	// Hide mid-click preference if Tab Mix Plus or Tab Clicking Options is enabled
	var browser = this.mWindowMediator.getMostRecentWindow("navigator:browser");
	if (browser) {
		if ((typeof(browser.tabClicking) != "undefined") || (typeof(browser.TM_checkClick) != "undefined")) {
			_("midClickPref").style.visibility = "collapse";
		}
		
		if (browser.gSingleWindowMode) _("overwrite").label = gSessionManager._string("overwrite_tabs");
	}

	// Disable default help window for Firefox 2.0 and below
	if (this.mAppVersion < "1.9") _("sessionmanagerOptions").openHelp = function () {}

	// Disable Apply Button by default
	_("sessionmanagerOptions").getButton("extra1").disabled = true;

	// Delay for Firefox 2.0.0.20 because it doesn't set window.innerHeight until after we run.
	if (this.mAppVersion < "1.9") setTimeout(adjustContentHeight,0);
	else adjustContentHeight();
};

gSessionManager.onUnload = function() {
	_("extensions.sessionmanager.options_selected_tab").valueFromPreferences = _("generalPrefsTab").selectedIndex;
};

var _disable = gSessionManager.setDisabled;

function readMaxClosedUndo()
{
	var value = _("extensions.sessionmanager.max_closed_undo").value;
	
	_disable(_("save_window_list"), value == 0);
	
	return value;
}

function readMaxTabsUndo()
{
	var value = _("browser.sessionstore.max_tabs_undo").value;
	
	_disable(_("save_closed_tabs"), value == 0);
	_disable(document.getElementsByAttribute("control", "save_closed_tabs")[0], value == 0);
	
	return value;
}

function promptClearUndoList()
{
	var max_tabs_undo = _("max_tabs").value;
	
	gSessionManager.clearUndoListPrompt();
	
	_("max_tabs").value = max_tabs_undo;
};

function readInterval()
{
	return _("browser.sessionstore.interval").value / 1000;
}

function writeInterval()
{
	return Math.round(parseFloat(_("interval").value) * 1000 || 0);
}

function readPrivacyLevel()
{
	var value = _("browser.sessionstore.privacy_level").value;
	
	_disable(_("postdata"), value > 1);
	_disable(document.getElementsByAttribute("control", "postdata")[0], value > 1);
	
	return value;
}

function _(aId)
{
	return document.getElementById(aId);
}

function selectSessionDir() {
	var nsIFilePicker = Components.interfaces.nsIFilePicker;
	var filepicker = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);

	filepicker.init(window, gSessionManager._string("choose_dir"), nsIFilePicker.modeGetFolder);
	filepicker.appendFilters(nsIFilePicker.filterAll);
	var ret = filepicker.show();
	if (ret == nsIFilePicker.returnOK) {
		_("extensions.sessionmanager.sessions_dir").value = filepicker.file.path;
	}
} 	 

function defaultSessionDir() {
	_("extensions.sessionmanager.sessions_dir").value = '';
}

function checkEncryption(aState) {
	try {
		// force a master password prompt so we don't waste time if user cancels it
		gSessionManager.mSecretDecoderRing.encryptString("");
	}
	catch (ex) {
		gSessionManager.cryptError(gSessionManager._string("change_encryption_fail"));
		return !aState;
	}
	_("encrypted_only").hidden = !aState;
	
	// When animating preferences the window can get cut off so just refresh the window size here
	if (aState && gSessionManager.getPref("browser.preferences.animateFadeIn", false, true))
		window.sizeToContent();
	
	return aState;
}

function checkEncryptOnly(aState) {
	if (aState && !_("extensions.sessionmanager.encrypted_only").valueFromPreferences) {
		if (!gSessionManager.mPromptService.confirm(window, gSessionManager.mTitle, gSessionManager._string("encrypt_only_confirm"))) {
			aState = false;
		}
	}
	
	return aState;
}

function startupSelect(index) {
	// hide/display corresponding menus	
	_("browserStartupPage").style.visibility = (index != 0)?"collapse":"visible";
	_("resume_session").style.visibility = (index != 2)?"collapse":"visible";
	if (index == 1) _("resume_session").style.visibility = "hidden";
}

function setStartValue() {
	_("extensions.sessionmanager.startup").valueFromPreferences = _("startupOption").selectedIndex;
}

function savePrefs() {
	var prefs = document.getElementsByTagName('preference');
	for (var i=0; i<prefs.length; i++) {
		prefs[i].valueFromPreferences = prefs[i].value;
	}
	setStartValue();
	
	// Disable Apply Button
	document.getElementById("sessionmanagerOptions").getButton("extra1").disabled = true;
}	

function enableApply() {
	document.getElementById("sessionmanagerOptions").getButton("extra1").disabled = false;
}

function goHelp() {
	var link = "http://sessionmanager.mozdev.org/options.html#";
	
	switch (_("sessionmanagerOptions").currentPane) {
		case (_("mainPrefPane")):
			switch (_("generalPrefsTab").selectedIndex) {
				case 0:
					link = link + "startup";
					break;
				case 1:
					link = link + "saving";
					break;
				case 2:
					link = link + "display";
					break;
			}
			break;
		case (_("undoclosePrefPane")):
			link = link + "undo";
			break;
		case (_("advancedPrefPane")):
			link = link + "advanced";
			break;
		case (_("sessionstorePrefPane")):
			link = link + "sessionstore";
			break;
	}
	
	openLink(link);
}

function openLink(url) {
	var top = Components.classes["@mozilla.org/appshell/window-mediator;1"]
             .getService(Components.interfaces.nsIWindowMediator).getMostRecentWindow("navigator:browser");
		             
    if (!top) window.open(url, "", "");
    else {
	    var tBrowser = top.getBrowser();
	    var currBlank = false;
			
		// Is current tab blank or already on help page.
		if (tBrowser && tBrowser.mCurrentTab.linkedBrowser) {
			var location = tBrowser.mCurrentTab.linkedBrowser.contentDocument.location.href;
			var index = location.indexOf("#");
			var baseLocation = (index == -1)? location : location.substring(0,index);
			index = url.indexOf("#");
			var baseURL = (index == -1)? url : url.substring(0,index);
			currBlank = (location == "about:blank") || (baseLocation == baseURL);
		}
				                   
		if (currBlank) tBrowser.loadURI(url);
		else {
			var tab = tBrowser.addTab(url);
			tBrowser.selectedTab = tab;
		}
	}
}

function adjustContentHeight() {
	// Localize strings aren't used when the initial height is used to calculate the size of the context-box
	// and preference window.  The height is calculated correctly once the window is drawn, but the context-box
	// and preference window heights are never updated.
	// To fix this, we need to explicitly set the height style of any element with a localized string that is more 
	// than one line (the descriptions).  This will correct the heights when the panes are selected.
	var largestNewPaneHeight = 0;
	var largestCurrentPaneHeight = 0;
	var biggestPane = null;
	for (var i=0; i < _("sessionmanagerOptions").preferencePanes.length; i++) {
		var pane = _("sessionmanagerOptions").preferencePanes[i];
		var descriptions = pane.getElementsByTagName('description');
		var adjustHeight = 0;
		for (var j=0; j<descriptions.length; j++) {
			var height = window.getComputedStyle(descriptions[j], null).height;
			if (height != "auto") {
				descriptions[j].style.height = height;
				adjustHeight += parseInt(height) - 26;
			}
		}
		adjustHeight = pane.contentHeight + adjustHeight;
		if (adjustHeight > largestNewPaneHeight) {
			largestNewPaneHeight = adjustHeight;
			biggestPane = pane;
		}
		if (pane.contentHeight > largestCurrentPaneHeight) 
			largestCurrentPaneHeight = pane.contentHeight;
	}
	// The exception to this is if the largest pane is already selected when the preference window is opened.  In
	// this case the window inner height must be correct as well as the context-box height (if animation is disabled).
	var currentPane = _("sessionmanagerOptions").currentPane;
	var animate = gSessionManager.getPref("browser.preferences.animateFadeIn", false, true);

	// When not animating, the largest pane's content height is not correct when it is opened first so update it.
	// Also the window needs to be resized to take into account the changes to the description height.
	if (!animate) {
		biggestPane._content.height = largestNewPaneHeight;
		window.sizeToContent();
	}
	// When animating the window needs to be resized to take into account the changes to the description height and
	// then shrunk since the opening pane is sized to the largest pane height which is wrong.
	else {
		var FF2 = gSessionManager.mAppVersion < "1.9";
		// Hide/show the encrypt only check box here when opening the largest pane to prevent window looking to large.
		if (currentPane == biggestPane) {
			FF2 |= _("encrypted_only").hidden = !_("encrypt_sessions").checked;
		}
	
		window.sizeToContent();
		// FF 2 needs to use largestCurrentPaneHeight - (largestNewPaneHeight - largestCurrentPaneHeight) size correctly
		// as does FF 3 and above when the encrypt only checkbox was hidden above
		var adjuster = (FF2) ? (2 * largestCurrentPaneHeight - largestNewPaneHeight) : largestCurrentPaneHeight;
		window.innerHeight -= adjuster - currentPane.contentHeight;
	}
	
	// Hide/show the encrypt only checkbox based on state of encryption checkbox
	_("encrypted_only").hidden = !_("encrypt_sessions").checked;
}