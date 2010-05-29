// Create a namespace so as not to polute the global namespace
if(!com) var com={};
if(!com.morac) com.morac={};

Components.utils.import("resource://sessionmanager/modules/logger.jsm");
Components.utils.import("resource://sessionmanager/modules/preference_manager.jsm");
Components.utils.import("resource://sessionmanager/modules/session_manager.jsm");

// use the namespace
with (com.morac) {
	com.morac.gSessionManagerSessionPrompt = {

		gParams: null,
		gSessionTree: null,
		gTextBox: null,
		gTextBoxVisible: false,
		ggMenuList: null,
		ggMenuListVisible: false,
		gTabTree: null,
		gTabTreeBox: null,
		gTreeSplitter: null,
		gCtrlClickNote: null,
		gAcceptButton: null,
		gExtraButton: null,
		gSessionNames: {},
		gGroupNames: [],
		gBackupGroupName: null,
		gBannedNames: [],
		gBackupNames: [],
		gSessionTreeData: null,
		gOriginalSessionTreeData: null,
		// gExistingName is the index of the item with the name in the text field.  -1 means no match
		gExistingName: -1,
		gNeedSelection: false,
		gInvalidTime: false,
		gFinishedLoading: false,
		gReDrawWindow: true,
		
		// Used to adjust height of window when unchecking "auto save" box
		gSavedEveryHeight: 0,

		// Used to keep track of the accept button position change
		gAcceptPositionDifference: 0,
		gTimerId: null,

		sortedBy: 0,

		// Input parameters stored in gSessionManager.sessionPromptData:
		// acceptExistingLabel  - Okay button label when overwriting existing session
		// acceptLabel          - Okay Button label for normal accept
		// addCurrentSession    - True when recovering from crash
		// allowNamedReplace    - True if double clicking a session name on save will replace existing session, but use default session name.
		//                        (This is currently only settable via a hidden preference - allowNamedReplace).
		// append_replace       - True if displaying the append/replace radio group, false otherwise
		// autoSaveable         - Displays autosave checkbox if true
		// callbackData         - Data to pass back to the gSessionManager.sessionPromptCallBack function.  Window will be modal if not set
		// crashCount           - Count String for current crashed session
		// defaultSessionName   - Default value comes from page title
		// filename             - Filename of session save file
		// getSessionsOverride  - Function to call to retrieve session list instead of gSessionManager.getSessions()
		// grouping             - True if changing grouping
		// ignorable            - Displays ignore checkbox if true
		// multiSelect          - True if allowed to choose multiple sessions (used for deleting)
		// preselect            - True if preselecting last backup session
		// remove               - True if deleting session(s)
		// selectAll            - True if all multiple items should be selected on initial prompt, false otherwise
		// sessionLabel         - Label at top of window
		// startupPrompt        - True if displayed when browser is first starting up, but not recovering from crash
		// textLabel            - Label above text box

		// Output parameters, stored in gSessionManager.sessionPromptReturnData
		// append               - True if append session, false if not
		// append_window        - True if append to window, false if not
		// autoSave             - True if autosave button pressed
		// autoSaveTime         - Auto save time value
		// filename             - Filename(s) - If multiple filenames returned, returned as "\n" separated string.
		// groupName            - Group Name
		// ignore               - True if ignore checkbox checked
		// sessionName          - Session Name
		// sessionState         - Session state when not all tabs are selected
		
		// SetInt 0 bit values
		// 1 = Accept or Extra1 button pressed

		// Used to disable saving if user switches to private browsing mode.
		observe: function(aSubject, aTopic, aData)
		{
			switch (aTopic)
			{
			case "private-browsing":
				this.checkPrivateBrowsingMode(aData == "enter", this.gParams.autoSaveable);
				break;
			}
		},

		persist: function(aObj, aAttr, aValue)
		{
			aObj.setAttribute(aAttr, aValue);
			document.persist(aObj.id, aAttr);
		},

		onLoad_proxy: function(aEvent) {
			this.removeEventListener("load", gSessionManagerSessionPrompt.onLoad_proxy, false);
			this.addEventListener("unload", gSessionManagerSessionPrompt.onUnload_proxy, false);
			gSessionManagerSessionPrompt.onLoad(aEvent);
		},
		
		onLoad: function(aEvent) {
			OBSERVER_SERVICE.addObserver(gSessionManagerSessionPrompt, "private-browsing", false);

			// Set "accept" value to false for modal windows
			window.arguments[0].QueryInterface(Components.interfaces.nsIDialogParamBlock).SetInt(0, 0);
			
			// Remove windowtype from modal windows to prevent them from being re-used
			if (!gSessionManager.sessionPromptData.callbackData) {
				this._("sessionmanagerPrompt").removeAttribute("windowtype");
			}
			
			this._("mac_title").hidden = !/mac/i.test(navigator.platform);
			
			this.gAcceptButton = document.documentElement.getButton("accept");
			this.gExtraButton = document.documentElement.getButton("extra1");

			// Store XUL references
			this.gTextBox = this._("text_box");
			this.ggMenuList = this._("group_menu_list");
			this.gTabTree = this._("tabTree");
			this.gTabTreeBox = this._("tabTreeBox");
			this.gTreeSplitter = this._("tree_splitter");
			this.gCtrlClickNote = this._("ctrl_click_note");
			this.gSessionTree = this._("session_tree");
			
			// Store "Constants"
			this.gBackupGroupName = gSessionManager._string("backup_sessions");

			// Disable saving in privacy mode
			this.checkPrivateBrowsingMode(gSessionManager.isPrivateBrowserMode(), gSessionManager.sessionPromptData.autoSaveable, true);
			
			// Show selection menu if window is not modal
			if (gSessionManager.sessionPromptData.callbackData) this._("menuBox").hidden = false;
			
			// Display the window
			this.drawWindow();

			// need to remove "rows" attribute otherwise session list jumps around when selecting.  Still need it to 
			// display 5 rows by default and to set minimum height persistence to prevent height from shrinking to 0.
			if (this.gSessionTree.hasAttribute("height"))
			{
				this.gSessionTree.height = this.gSessionTree.getAttribute("height");
			}
			else
			{
				this.persist(this.gSessionTree, "minheight", this.gSessionTree.treeBoxObject.height);
			}
			this.gSessionTree.removeAttribute("rows");
			
			// This is never true when running under windows
			if (!window.opener)
			{
				document.title += " - " + document.getElementById("bundle_brand").getString("brandFullName");
				document.documentElement.removeAttribute("screenX");
				document.documentElement.removeAttribute("screenY");
			}
			
			window.sizeToContent();
			// Adjust window so it's not offscreen
			this.adjustWindowSizeAndPosition();
			
			// watch for resize to prevent user from shrinking window so small it hides dialog buttons.
			window.onresize = gSessionManagerSessionPrompt.resize;
			
			this.gFinishedLoading = true;
		},

		onUnload_proxy: function(aEvent) {
			this.removeEventListener("unload", gSessionManagerSessionPrompt.onUnload_proxy, false);
			gSessionManagerSessionPrompt.onUnload(aEvent);
		},
		
		onUnload: function(aEvent) {
			this.gSessionTree.removeEventListener("select", gSessionManagerSessionPrompt.onSessionTreeSelect_proxy, false);
			OBSERVER_SERVICE.removeObserver(gSessionManagerSessionPrompt, "private-browsing");
			
			// Clear any currently stored functions
			if (this.gParams) {
				delete this.gParams.getSessionsOverride;
			}
			
			if (window.opener)
			{
				this.persist(document.documentElement, "screenX", window.screenX);
				this.persist(document.documentElement, "screenY", window.screenY);
			}
			
			this.persistTreeHeights();
			
			// The following line keeps the window width from increasing when sizeToContent is called.
			this._("sessionmanagerPrompt").width = window.innerWidth - 1;
			
			// Handle case if user closes window without click Okay.
			gSessionManager.sessionPromptReturnData = gSessionManager.sessionPromptReturnData || {};
			gSessionManager.sessionPromptReturnData.ignore = this._("checkbox_ignore").checked;
		},

		// Draw the window using parameters from gSessionManager.sessionPromptData
		drawWindow: function() {
			
			// Clear any currently stored functions
			if (this.gParams) {
				delete this.gParams.getSessionsOverride;
			}
			
			// store input parameters and 
			this.gParams = {
				// strings
				acceptExistingLabel: gSessionManager.sessionPromptData.acceptExistingLabel,
				acceptLabel: gSessionManager.sessionPromptData.acceptLabel,
				callbackData: gSessionManager.sessionPromptData.callbackData,
				crashCount: gSessionManager.sessionPromptData.crashCount,
				defaultSessionName: gSessionManager.sessionPromptData.defaultSessionName,
				filename: gSessionManager.sessionPromptData.filename,
				sessionLabel: gSessionManager.sessionPromptData.sessionLabel,
				textLabel: gSessionManager.sessionPromptData.textLabel,
				// booleans
				addCurrentSession: gSessionManager.sessionPromptData.addCurrentSession,
				allowNamedReplace: gSessionManager.sessionPromptData.allowNamedReplace,
				append_replace: gSessionManager.sessionPromptData.append_replace,
				autoSaveable: gSessionManager.sessionPromptData.autoSaveable,
				grouping: gSessionManager.sessionPromptData.grouping,
				ignorable: gSessionManager.sessionPromptData.ignorable,
				multiSelect: gSessionManager.sessionPromptData.multiSelect,
				preselect: gSessionManager.sessionPromptData.preselect,
				remove: gSessionManager.sessionPromptData.remove,
				selectAll: gSessionManager.sessionPromptData.selectAll,
				startupPrompt: gSessionManager.sessionPromptData.startupPrompt,
				// override function
				getSessionsOverride: gSessionManager.sessionPromptData.getSessionsOverride
			};
			
			// Update selection menu if not modal
			if (this.gParams.callbackData) {
				let label = null;
				switch(this.gParams.callbackData.type) {
					case "save":
						label = this.gParams.callbackData.oneWindow ? this._("saveWin").label : this._("save").label;
						break;
					case "load": 
						label = this._("load").label;
						break;
					case "rename":
						label = this._("rename").label;
						break;
					case "group":
						label = this._("group").label;
						break;
					case "delete":
						label = this._("remove").label;
						break;
				}
				// don't update window if same command used
				if (this._("actionButton").label == label) return;
				this._("actionButton").label = label;
			}
			
			// Clear any passed functions and parameters from global variable to prevent leaking
			delete gSessionManager.sessionPromptData.getSessionsOverride;
			gSessionManager.sessionPromptData = null;

			this.gAcceptButton.label = this.gParams.acceptLabel || this.gAcceptButton.label;
			this.gSessionTree.selType = (this.gParams.multiSelect)?"multiple":"single";

			var currentSessionTreeHeight = this.gSessionTree.treeBoxObject.height;
			
			// if not initial window load
			if (this.gFinishedLoading) {
				// hide text boxes
				this.gTextBoxVisible = !(this._("group-text-container").hidden = true);
				this.ggMenuListVisible = !(this._("session-text-container").hidden = true);

				// hide tab tree if not saving
				if (!this.gParams.autoSaveable) this.gTabTreeBox.hidden = this.gTreeSplitter.hidden = true;
				this.gSessionTree.removeEventListener("select", gSessionManagerSessionPrompt.onSessionTreeSelect_proxy, false);
				
				// Save current session and tab tree heights
				this.persistTreeHeights();
				
				// Hide and disable extra button
				this.gExtraButton.disabled = this.gExtraButton.hidden = true;
			}
			
			this.gReDrawWindow = true;
			this.updateWindow();
			this.gReDrawWindow = false;

			// Display Tab Tree if saving session otherwise adjust height if not initial load
			if (this.gParams.autoSaveable && this.gParams.callbackData) {
				this.displayTabTree();
			}
			else if (this.gFinishedLoading) {
				// Fix session tree height to prevent it from changing
				this.adjustSessionTreeHeight(currentSessionTreeHeight);
			}
		},

		// Update window without re-reading parameters
		updateWindow: function() {
			// If already loaded
			if (this.gFinishedLoading) {
				
				// Reset variables
				this.gSessionNames = {};
				this.gGroupNames = [];
				this.gBannedNames = [];
				this.gBackupNames = [];
				this.gExistingName = -1;
				this.gInvalidTime = false;
				
				// Remove old descriptions
				this.removeDescriptions();

				// unselect any selected session
				this.gSessionTree.view.selection.clearSelection();
					
				// clean up text boxes
				this.ggMenuList.removeAllItems();
				this.ggMenuList.value = "";
				this.gTextBox.value = "";
				this.onTextboxInput();
				
				// make sure session tree is not disabled
				this.gSessionTree.disabled = false;
				
				if (!this.gReDrawWindow) {
					// remove any preentered filename or preselected name
					this.gParams.filename = "";
					this.gParams.defaultSessionName = "";
				}
			}

			this.setDescription(this._("session_label"), this.gParams.sessionLabel);
			
			var sessions = null;
			if (this.gParams.getSessionsOverride) {
				if (typeof this.gParams.getSessionsOverride == "function") {
					try {
						sessions = this.gParams.getSessionsOverride();
					} catch (ex) { 
						log("Override function error. " + ex, "ERROR", true);
					}
				}
				else {
					log("Passed override function parameter is not a function.", "ERROR", true);
				}
				if (!sessions || !this._isValidSessionList(sessions)) {
					window.close();
					return;
				}
			}
			else {
				sessions = gSessionManager.getSessions();
			}

			// Disable non-saving menuitems if no sessions
			gSessionManager.setDisabled(this._("load"), !sessions.length);
			gSessionManager.setDisabled(this._("rename"), !sessions.length);
			gSessionManager.setDisabled(this._("remove"), !sessions.length);
			gSessionManager.setDisabled(this._("group"), !sessions.length);
			
			if (this.gParams.addCurrentSession) // add a "virtual" current session
			{
				sessions.unshift({ name: gSessionManager._string("current_session"), fileName: "*" });
			}
			
			// Do not allow overwriting of open window or browser sessions (clone it so we don't overwrite the global variable)
			for (let i in gSessionManager.mActiveWindowSessions) {
				this.gBannedNames[i] = gSessionManager.mActiveWindowSessions[i];
			}
			var currentSession = gPreferenceManager.get("_autosave_values", "").split("\n")[0];
			if (currentSession) this.gBannedNames[currentSession.trim().toLowerCase()] = true;
			
			// hide/show the "Don't show [...] again" checkbox
			this._("checkbox_ignore").hidden = !(this.gParams.ignorable);

			// hide/show the Autosave checkboxes
			this._("checkbox_autosave").hidden = !(this.gParams.autoSaveable);
			this._("save_every").hidden = this._("checkbox_autosave").hidden || !this._("checkbox_autosave").checked;
			
			// hide/show the append/replace radio buttons
			this._("radio_append_replace").hidden = !(this.gParams.append_replace);
			this._("radio_append_replace").selectedIndex = gPreferenceManager.get("overwrite", false) ? 1 : (gPreferenceManager.get("append_by_default", false) ? 2 : 0);
			if (window.opener && (typeof(window.opener.gSingleWindowMode) != "undefined") && window.opener.gSingleWindowMode) {
				if (!this._("radio_append_replace").selectedIndex) this._("radio_append_replace").selectedIndex = 2;
				this._("radio_append").hidden = true;
			}

			this.gBackupNames[gSessionManager._string("backup_session").trim().toLowerCase()] = true;
			this.gBackupNames[gSessionManager._string("autosave_session").trim().toLowerCase()] = true;
			
			var saving = (this.gParams.autoSaveable);
			var grouping = (this.gParams.grouping);
			var loading = (this.gParams.append_replace);  // not true for crash or start session prompt
			var preselect = (this.gParams.preselect);
			var groupCount = 0;
			var selected;
			this.gSessionTreeData = [];
			sessions.forEach(function(aSession) {
				var trimName = aSession.name.trim().toLowerCase();
				// ban backup session names
				if (aSession.backup) this.gBackupNames[trimName] = true;
				// Don't display loaded sessions in list for load or save or backup items in list for save or grouping
				if (!((aSession.backup && (saving || grouping)) || ((this.gBannedNames[trimName]) && (saving || loading || (this.gParams.addCurrentSession)))))
				{
					// get window and tab counts and group name for crashed session
					if (aSession.fileName == "*") {
						aSession.group = this.gBackupGroupName;
						var counts = this.gParams.crashCount.split(",");
						aSession.windows = counts[0];
						aSession.tabs = counts[1];
					}
					
					// Break out Autosave variables
					if (aSession.autosave) {
						var autosave = aSession.autosave.split("/");
						aSession.autosave = autosave[0];
						aSession.autosave_time = autosave[1];
					}
					
					// Mark if session loaded
					aSession.loaded = this.gBannedNames[trimName] || null;
					
					// Flag latest session
					if ((sessions.latestTime && (sessions.latestTime == aSession.timestamp) && !(this.gParams.addCurrentSession)) || (aSession.fileName == "*")) {
						aSession.latest = true;
					}
					
					// Select previous session if requested to do so and no session name passed
					if (preselect && aSession.backup && !this.gParams.filename && (sessions.latestBackUpTime == aSession.timestamp)) {
						selected = this.gSessionTreeData.length;
					}

					// select passed in item (if any)
					if (aSession.fileName == this.gParams.filename) selected = this.gSessionTreeData.length;

					// Add session to name list
					this.gSessionNames[trimName] = this.gSessionTreeData.length;
					
					// Push to Tree database and backup
					this.gSessionTreeData.push(aSession);
					
					// Build group menu list
					if (aSession.group && !aSession.backup) {
						// Don't treat special chars in group as regular expression characters
						let groupRegExp = aSession.group.replace(/([\(\)\[\]\^\$\*\+\|\.\\\/])/g,"\\$1");
						let regExp = new RegExp("^" + groupRegExp + "|," + groupRegExp + "$|," + groupRegExp + ",");
						if (!regExp.test(this.gGroupNames.toString())) {
							this.gGroupNames[groupCount++] = aSession.group.trim();
						}
					}
				}
			}, this);
			
			// Make a copy of array
			this.gOriginalSessionTreeData = this.gSessionTreeData.slice(0);
			
			// Display Tree
			this.gSessionTree.view = this.sessionTreeView;
			
			// select passed in item (if any)
			if (typeof(selected) != "undefined") this.gSessionTree.view.selection.select(selected);
			
			if ((this.gParams.selectAll)) this.gSessionTree.view.selection.selectAll()

			// If there is a text box label, enable text boxes
			if (this.gParams.textLabel)
			{
				this._("text_container").hidden = false;
				this.setDescription(this._("text_label"), this.gParams.textLabel);
				
				// If renaming and name already entered, disable the session selection list
				this.gSessionTree.disabled = this.gParams.filename && !this.gParams.acceptExistingLabel;

				// group text input is enabled when saving or group changing
				if ((this.gParams.grouping) || this.gParams.acceptExistingLabel) 
				{
					this.ggMenuListVisible = !(this._("group-text-container").hidden = false);

					// Pre-populate Group Menu
					this.gGroupNames.sort();
					for (var i in this.gGroupNames) {
						this.ggMenuList.appendItem(this.gGroupNames[i]);
					}
				}
						
				// session text input is enabled when not group changing (i.e., when saving or renaming)
				if (!(this.gParams.grouping)) 
				{
					this.gTextBoxVisible = !(this._("session-text-container").hidden = false);
				
					// Pre-populate the text box with default session name if saving and the name is not banned or already existing.
					// Otherwise disable accept button
					var trimname = this.gParams.defaultSessionName.trim().toLowerCase();
					if (this.gParams.acceptExistingLabel && !this.gBannedNames[trimname] && ((this.gSessionNames[trimname] == undefined) || (this.gParams.allowNamedReplace)))
					{
						this.onTextboxInput(this.gParams.defaultSessionName);
					}
					else this.gAcceptButton.disabled = true;
				}
			}
			
			// Force user to make a selection if no text or group box or not saving (i.e., deleting or renaming)
			if ((this.gNeedSelection = !this.gTextBoxVisible || !this.ggMenuListVisible || !this.gParams.acceptExistingLabel) || (this.gParams.allowNamedReplace))
			{
				this.gSessionTree.addEventListener("select",gSessionManagerSessionPrompt.onSessionTreeSelect_proxy, false);
				this.onSessionTreeSelect();
			}
			else this.isAcceptable();
		},
		
		onSessionTreeClick: function(aEvent)
		{
			if ((aEvent.button == 0) && !aEvent.metaKey && !aEvent.ctrlKey && !aEvent.shiftKey && !aEvent.altKey) {
				if (aEvent.target.nodeName=="treechildren") {
					switch (aEvent.type) {
						case "click":
							if (this.gTextBoxVisible && !(this.gParams.allowNamedReplace)) this.onTextboxInput(this.gSessionTreeData[this.gSessionTree.currentIndex].name);
							break;
						case "dblclick":
							if (!(this.gParams.remove)) 
								this.gAcceptButton.doCommand();
							break;
					}
				}
				else if ((aEvent.type == "click") && (aEvent.target.nodeName == "treecol")) {
					var types = { name: 0, group: 1, win_count: 2, tab_count: 3 };
					var which = types[aEvent.target.id];
					
					// If not already sorted, this.sortedBy will be 0.  Otherwise it is which + 1 if sorted or -(which + 1) if inversely sorted
					var flag = (Math.abs(this.sortedBy) == (which + 1)) ? (-this.sortedBy / Math.abs(this.sortedBy)) : 1
					
					// Save selected items so they can be restored
					var selectedFileNames = {};
					var start = new Object();
					var end = new Object();
					var numRanges = this.gSessionTree.view.selection.getRangeCount();

					for (var t = 0; t < numRanges; t++) {
						this.gSessionTree.view.selection.getRangeAt(t,start,end);
						for (var v = start.value; v <= end.value; v++){
							selectedFileNames[this.gSessionTreeData[v].fileName] = true;
						}
					}
					
					// Clear all selected items
					this.gSessionTree.view.selection.clearSelection();
					
					// If inversely sorted and user clicks header again, go back to original order
					if (flag && this.sortedBy < 0) {
						flag = 0;
						this.gSessionTreeData = this.gOriginalSessionTreeData.slice(0);
					}
					else {
						// Sort depending on which header is clicked
						switch (which) {
							case 0:
								this.gSessionTreeData = this.gSessionTreeData.sort(function(a, b) { 
									return flag * (a.name.toLowerCase().localeCompare(b.name.toLowerCase())); 
								});
								break;
							case 1:
								this.gSessionTreeData = this.gSessionTreeData.sort(function(a, b) { 
									return flag * (a.group.toLowerCase().localeCompare(b.group.toLowerCase())); 
								});
								break;
							case 2:
								this.gSessionTreeData = this.gSessionTreeData.sort(function(a, b) { 
									return flag * (parseInt(a.windows) - parseInt(b.windows)); 
								});
								break;
							case 3:
								this.gSessionTreeData = this.gSessionTreeData.sort(function(a, b) { 
									return flag * (parseInt(a.tabs) - parseInt(b.tabs)); 
								});
								break;
						}
					}
					
					// Recreate Session List index and restore selected items
					for (var i=0; i<this.gSessionTreeData.length; i++) {
						var trimName = this.gSessionTreeData[i].name.trim().toLowerCase();
						this.gSessionNames[trimName] = i;
						
						if (selectedFileNames[this.gSessionTreeData[i].fileName]) {
							this.gSessionTree.view.selection.toggleSelect(i);
						}
					}
					this.sortedBy = flag * (which + 1);

					// update header arrorws			
					for (var i=0; i < aEvent.target.parentNode.childNodes.length; i++) {
						var sortText = flag ? ((flag>0) ? "ascending" : "descending") : "natural";
						aEvent.target.parentNode.childNodes[i].setAttribute("sortDirection", ((aEvent.target.parentNode.childNodes[i] == aEvent.target) ? sortText : "natural"))
					}
					
					// Redraw the tree - Needed for OS X
					this.gSessionTree.treeBoxObject.invalidate();
				}
			}
		},

		onSessionTreeKeyPress: function(aEvent)
		{
			if (this.gTextBoxVisible && (aEvent.keyCode == aEvent.DOM_VK_RETURN) && (this.gSessionTree.view.selection.count > 0)) {
				this.onTextboxInput(this.gSessionTreeData[this.gSessionTree.currentIndex].name);
				aEvent.preventDefault();
			}
		},
		
		onSessionTreeSelect_proxy: function(aEvent)
		{
			gSessionManagerSessionPrompt.onSessionTreeSelect(aEvent)
		},

		displayTabTree: function()
		{
				// save current session tree height before doing any unhiding (subtract one if called initiall since height is off by one in that case)
				var currentSessionTreeHeight = this.gSessionTree.treeBoxObject.height - (!this.gFinishedLoading ? 0 : 1);
				var tabTreeWasHidden = this.gTabTreeBox.hidden;
				
				// hide tab tree and splitter if more or less than one item is selected or muliple selection is enabled, but not deleting (used for converting sessions)
				// hide the click note if append/replace buttons are displayed (manual load)
				var hideTabTree = !this.gParams.autoSaveable && !!((this.gSessionTree.view.selection.count != 1) || ((this.gParams.multiSelect) && !(this.gParams.remove)));
				this.gTreeSplitter.hidden = this.gTabTreeBox.hidden = hideTabTree;
				this.gCtrlClickNote.hidden = hideTabTree || !(this.gParams.append_replace) || this.gParams.autoSaveable;
				
				// if displaying the tab tree, initialize it and then, if the tab tree was hidden, 
				// resize the window based on the current persisted height of the tab tree and the
				// current session tree height.  
				if (!hideTabTree) {
					// if deleting, change column label
					if (this.gParams.remove) {
						this._("restore").setAttribute("label", gSessionManager._string("remove_session_ok"));
					}
					else if (this.gParams.autoSaveable) {
						this._("restore").setAttribute("label", this._("save_label").getAttribute("value"));
					}
					gSessionManagerSessionBrowser.initTreeView(this.gParams.autoSaveable ? "" : this.gSessionTreeData[this.gSessionTree.currentIndex].fileName, this.gParams.remove, this.gParams.startupPrompt, this.gParams.autoSaveable);
				}
				
				// If tab tree was displayed or hidden, adjust session tree height
				if (this.gFinishedLoading && tabTreeWasHidden != hideTabTree) {
					if (!hideTabTree && this.gTabTree.hasAttribute("height"))
					{
						this.gTabTree.height = this.gTabTree.getAttribute("height");
					}
					
					// Fix session tree height to prevent it from changing
					this.adjustSessionTreeHeight(currentSessionTreeHeight);
				}
		},
		
		onSessionTreeSelect: function(aEvent)
		{
			// If no session name or group name text box, disable the accept button if nothing selected.
			// Otherwise isAcceptable when changing groups or onTextboxInput otherwise.
			if (!this.gTextBoxVisible && !this.ggMenuListVisible)
			{
				this.gAcceptButton.disabled = this.gSessionTree.view.selection.count == 0;
				
				// Display Tab Tree
				this.displayTabTree();
			}
			else
			{
				if (this.gTextBoxVisible) this.onTextboxInput();
				else this.isAcceptable();
			}
		},

		onTextboxInput: function(aNewValue)
		{
			if (aNewValue)
			{
				var match = /   \([0-9]+\/[0-9]+\)$/m.exec(aNewValue);
				if (match)
				{
					aNewValue = aNewValue.substring(0,match.index);
				}
				this.gTextBox.value = aNewValue;
				setTimeout(function() { gSessionManagerSessionPrompt.gTextBox.select(); gSessionManagerSessionPrompt.gTextBox.focus(); }, 0);
			}
			
			var input = this.gTextBox.value.trim().toLowerCase();
			var oldWeight = !!this.gAcceptButton.style.fontWeight;
			
			this.gExistingName = (this.gSessionNames[input] != undefined) ? this.gSessionNames[input] : -1;
			var newWeight = !!((this.gExistingName >= 0) || ((this.gParams.allowNamedReplace) && this.gSessionTree.view.selection.count > 0));
			
			if (!this._("checkbox_autosave").hidden) {
				var currentChecked = this._("checkbox_autosave").checked;
				if (this.gExistingName >= 0) {
					this._("checkbox_autosave").checked = this.gSessionTreeData[this.gExistingName].autosave != "false";
					this._("autosave_time").value = this.gSessionTreeData[this.gExistingName].autosave_time || "";
				}
				else {
					this._("checkbox_autosave").checked = false;
					this._("autosave_time").value = "";
				}
				if (currentChecked != this._("checkbox_autosave").checked) this._save_every_update();
			}
			
			if (!this.gNeedSelection && oldWeight != newWeight)
			{
				this.gAcceptButton.label = (newWeight && this.gParams.acceptExistingLabel)?this.gParams.acceptExistingLabel:this.gParams.acceptLabel;
				this.gAcceptButton.style.fontWeight = (newWeight)?"bold":"";
				// Show append button if replace button is shown.
				this.gExtraButton.hidden = this.gAcceptButton.label != this.gParams.acceptExistingLabel
			}
			this.gExtraButton.disabled = this.gExtraButton.hidden || this._("checkbox_autosave").checked;

			// Highlight matching item when accept label changes to replace and copy in group value (only when saving and not replacing name)
			if (newWeight && this.gParams.acceptExistingLabel && !(this.gParams.allowNamedReplace)) {
				this.gSessionTree.view.selection.select(this.gExistingName);
				if (this.ggMenuListVisible) this.ggMenuList.value = this.gSessionTreeData[this.gExistingName].group;
			}
				
			this.isAcceptable();
		},

		isAcceptable: function() 
		{
			var badSessionName = false;
			var badGroupName = false;
			
			if (gSessionManagerSessionPrompt.ggMenuListVisible) {
				var groupName = gSessionManagerSessionPrompt.ggMenuList.value.trim();
				badGroupName = (groupName == gSessionManagerSessionPrompt.gBackupGroupName)
				gSessionManagerSessionPrompt.ggMenuList.inputField.setAttribute("badname", badGroupName);
			}
			
			if (gSessionManagerSessionPrompt.gTextBoxVisible) {
				var input = gSessionManagerSessionPrompt.gTextBox.value.trim().toLowerCase();
				gSessionManagerSessionPrompt.gTextBox.setAttribute("badname", gSessionManagerSessionPrompt.gBackupNames[input]);
				badSessionName = !input || gSessionManagerSessionPrompt.gBackupNames[input] || gSessionManagerSessionPrompt.gBannedNames[input];
			}
			
			gSessionManagerSessionPrompt.gAcceptButton.disabled = gSessionManagerSessionPrompt.gExtraButton.disabled =
				gSessionManagerSessionPrompt.gInvalidTime || badSessionName || badGroupName || (this.gParams.autoSaveable && gSessionManager.isPrivateBrowserMode()) ||
				(this.gParams.autoSaveable && gSessionManagerSessionBrowser.gNoTabsChecked) ||
				(gSessionManagerSessionPrompt.gNeedSelection && (gSessionManagerSessionPrompt.gSessionTree.view.selection.count == 0 || (gSessionManagerSessionPrompt.gExistingName >= 0)));
		},

		// aParam = true if user clicked extra1 button (Append), false otherwise
		onAcceptDialog: function(aParam)
		{
			// Put up warning prompt if deleting
			if (this.gParams.remove) {
				var dontPrompt = { value: false };
				if (gPreferenceManager.get("no_delete_prompt") || PROMPT_SERVICE.confirmEx(window, gSessionManager.mTitle, gSessionManager._string("delete_confirm"), PROMPT_SERVICE.BUTTON_TITLE_YES * PROMPT_SERVICE.BUTTON_POS_0 + PROMPT_SERVICE.BUTTON_TITLE_NO * PROMPT_SERVICE.BUTTON_POS_1, null, null, null, gSessionManager._string("prompt_not_again"), dontPrompt) == 0) {
					if (dontPrompt.value) {
						gPreferenceManager.set("no_delete_prompt", true);
					}
				}
				else return false;
			}

			let filename;
			if (this.gNeedSelection || ((this.gParams.allowNamedReplace) && this.gSessionTree.view.selection.count > 0))
			{
				var selectedFileNames = [];
				var start = new Object();
				var end = new Object();
				var numRanges = this.gSessionTree.view.selection.getRangeCount();

				for (var t = 0; t < numRanges; t++) {
					this.gSessionTree.view.selection.getRangeAt(t,start,end);
					for (var v = start.value; v <= end.value; v++){
						selectedFileNames.push(this.gSessionTreeData[v].fileName);
					}
				}
				filename = selectedFileNames.join("\n");
			}
			else if (this.gExistingName >= 0)
			{
				var dontPrompt = { value: false };
				if (aParam || gPreferenceManager.get("no_overwrite_prompt") || 
					PROMPT_SERVICE.confirmEx(null, gSessionManager.mTitle, gSessionManager._string("overwrite_prompt"), PROMPT_SERVICE.BUTTON_TITLE_YES * PROMPT_SERVICE.BUTTON_POS_0 + PROMPT_SERVICE.BUTTON_TITLE_NO * PROMPT_SERVICE.BUTTON_POS_1, null, null, null, gSessionManager._string("prompt_not_again"), dontPrompt) == 0)
				{
					filename = this.gSessionTreeData[this.gExistingName].fileName;
					if (dontPrompt.value)
					{
						gPreferenceManager.set("no_overwrite_prompt", true);
					}
				}
				else {
					return false;
				}
			}
			else
			{
				filename  = "";
			}
			
			gSessionManager.sessionPromptReturnData = { 
				append: ((this._("radio_append").selected && !this._("radio_append_replace").hidden) || aParam),
				append_window: this._("radio_append_window").selected, 
				autoSave: this._("checkbox_autosave").checked,
				autoSaveTime: (this._("checkbox_autosave").checked ? parseInt(this._("autosave_time").value.trim()) : null),
				filename: filename,
				groupName: this._("group_menu_list").value.trim(),
				ignore: this._("checkbox_ignore").checked, 
				sessionState: gSessionManagerSessionBrowser.gAllTabsChecked ? null : gSessionManagerSessionBrowser.storeSession(),
				sessionName: this._("text_box").value.trim()
			};
			
			if (this.gParams.callbackData) {
				try {
					gSessionManager.sessionPromptCallBack(this.gParams.callbackData);
				} catch(ex) {
					logError(ex);
				}
				// clear out return data and preset to not accepting
				gSessionManager.sessionPromptReturnData = null;
				this.updateWindow();
				return false;
			}
			else {
				// If modal, set "accept" value
				window.arguments[0].QueryInterface(Components.interfaces.nsIDialogParamBlock).SetInt(0, 1);
			}
			
			// Click extra button doesn't close window so do that here
			if (aParam) window.close();
		},
		
		onSelectMenu: function(aEvent) {
			if (this._("actionButton").label == aEvent.explicitOriginalTarget.label) return;
				
			switch(aEvent.explicitOriginalTarget.id) {
				case "save":
					gSessionManager.save();
					break;
				case "saveWin":
					gSessionManager.saveWindow();  // TODO figure this out later - currently menu item is hidden so it can't be selected
					break;
				case "load": 
					gSessionManager.load();
					break;
				case "rename":
					gSessionManager.rename();
					break;
				case "group":
					gSessionManager.group();
					break;
				case "remove":
					gSessionManager.remove();
					break;
			}
		},

		setDescription: function(aObj, aValue)
		{
			aValue.split("\n").forEach(function(aLine) {
				let description = document.createElement("description");
				description.className = "addedDescription";
				aObj.appendChild(description).textContent = aLine;
			});
		},

		removeDescriptions: function() {
			let descriptions = document.getElementsByTagName("description");
			let ignored = 0;
			while (descriptions.length > ignored) {
				if (descriptions[ignored].className == "addedDescription") {
					descriptions[ignored].parentNode.removeChild(descriptions[ignored]);
				}
				else {
					ignored++;
				}
			}
		},

		persistTreeHeights: function() {
			// only persist tree heights is neither is collapsed to prevent "giant" trees
			if (this.gTreeSplitter.getAttribute("state") != "collapsed") {
				// persist session tree height if it has a height, subtract one if tab Tree is hidden because one is added if it is
				if (this.gSessionTree && this.gSessionTree.treeBoxObject.height > 0) {
					var tweak = this.gTabTreeBox.hidden ? 1 : 0;
					this.persist(this.gSessionTree, "height", this.gSessionTree.treeBoxObject.height - tweak);
					log("persistTreeHeights: persist session tree height = " + this.gSessionTree.treeBoxObject.height + ", tweak = " + tweak, "DATA");
				}
				// persist tab tree height if it has a height
				if (this.gTabTree && this.gTabTree.treeBoxObject.height > 0) {
					this.persist(this.gTabTree, "height", this.gTabTree.treeBoxObject.height);
					log("persistTreeHeights: persist tab tree height = " + this.gTabTree.treeBoxObject.height, "DATA");
				}
			}
			log("persistTreeHeights: session tree height = " + this.gSessionTree.getAttribute("height") + ", tab tree height = " + this.gTabTree.getAttribute("height"), "DATA");
		},

		// Fix session tree height to prevent it from changing
		adjustSessionTreeHeight: function(currentSessionTreeHeight) {
			// Restore height and save it for when window closes
			this.gSessionTree.height = currentSessionTreeHeight;
			
			// The following line keeps the window width from increasing when sizeToContent is called.
			this._("sessionmanagerPrompt").width = window.innerWidth - 1;
			window.sizeToContent();
			// The following is needed because the session tree usually shrinks when calling the above
			window.innerHeight = window.innerHeight - this.gSessionTree.treeBoxObject.height + currentSessionTreeHeight;
			
			// Adjust window so it's not offscreen
			this.adjustWindowSizeAndPosition();
			log("onSessionTreeSelect: window.screenY = " + window.screenY + ", window.screen.availHeight = " + window.screen.availHeight + ", window.outerHeight = " + window.outerHeight, "DATA");
		},
		
		adjustWindowSizeAndPosition: function() {
			// Make sure window height isn't larger than screen height
			if (window.screen.availHeight < window.outerHeight) {
				window.outerHeight = window.screen.availHeight;
			}
			// Make sure the bottom of the window is visible by moving the window up if necessary
			if (window.screenY + window.outerHeight > window.screen.availHeight) {
				window.screenY = window.screen.availHeight - window.outerHeight;
			}
		},

		checkPrivateBrowsingMode: function(inPrivateBrowsing, aSaving, aJustOpened)
		{
			gSessionManager.setDisabled(this._("save"), inPrivateBrowsing);
			gSessionManager.setDisabled(this._("saveWin"), inPrivateBrowsing);
			
			// If saving, disable, the save or append button
			if (aSaving) {
				if (inPrivateBrowsing) {
					this.gAcceptButton.disabled = true;
					this.gExtraButton.disabled = true;
				}
				else if (!aJustOpened) this.isAcceptable();
			}
		},

		_: function(aId)
		{
			return document.getElementById(aId);
		},

		_isValidSessionList: function(aSessions)
		{
			if (aSessions==null || typeof(aSessions)!="object" || typeof(aSessions.length)!="number" || 
				aSessions.length == 0 || !aSessions[0].name) {
				log("Override function returned an invalid session list.", "ERROR", true);
				return false;
			}
			return true;
		},

		_save_every_update: function()
		{
			var checked = gSessionManagerSessionPrompt._('checkbox_autosave').checked;
			var save_every_height = null;
			
			gSessionManagerSessionPrompt._('save_every').hidden = !checked;
			
			// resize window
			if (checked) {
				save_every_height = parseInt(window.getComputedStyle(gSessionManagerSessionPrompt._('save_every'), "").height);
				if (isNaN(save_every_height)) save_every_height = 0;
				gSessionManagerSessionPrompt.gSavedEveryHeight = save_every_height;
				window.innerHeight += save_every_height;
			}
			else {
				if (typeof(gSessionManagerSessionPrompt.gSavedEveryHeight) == "number") {
					window.innerHeight -= gSessionManagerSessionPrompt.gSavedEveryHeight;
				}
			}
		},

		isNumber: function(aTextBox)
		{
			this.gInvalidTime = !/^([1-9]\d*)?$/.test(aTextBox.value);
			aTextBox.setAttribute("badname", this.gInvalidTime ? "true" : "false");
			
			this.isAcceptable();
		},

		// if the accept button is no longer moving when resizing, the window is too small so make it bigger.
		resize: function(aEvent, aString)
		{
			var currentAcceptPositionDifference = window.outerHeight - gSessionManagerSessionPrompt.gAcceptButton.boxObject.y;
			if (!gSessionManagerSessionPrompt.gAcceptPositionDifference) {
				gSessionManagerSessionPrompt.gAcceptPositionDifference = currentAcceptPositionDifference;
			}
			else if (currentAcceptPositionDifference != gSessionManagerSessionPrompt.gAcceptPositionDifference) {
				if (gSessionManagerSessionPrompt.gTimerId) {
					clearTimeout(gSessionManagerSessionPrompt.gTimerId);
					delete gSessionManagerSessionPrompt.gTimerId;
				}
				gSessionManagerSessionPrompt.gTimerId = setTimeout(function() {window.resizeTo(window.outerWidth,window.outerHeight + gSessionManagerSessionPrompt.gAcceptPositionDifference - currentAcceptPositionDifference);}, 100);
			}
		},

		// Tree controller

		sessionTreeView: {
			_atoms: {},
			_getAtom: function(aName)
			{
				if (!this._atoms[aName]) {
					var as = Components.classes["@mozilla.org/atom-service;1"].getService(Components.interfaces.nsIAtomService);
					this._atoms[aName] = as.getAtom(aName);
				}
				return this._atoms[aName];
			},

			treeBox: null,
			selection: null,

			get rowCount()                     { return gSessionManagerSessionPrompt.gSessionTreeData.length; },
			setTree: function(treeBox)         { this.treeBox = treeBox; },
			getCellText: function(idx, column) { 
				switch(column.id) {
					case "name":
						return gSessionManagerSessionPrompt.gSessionTreeData[idx].name;
						break;
					case "group":
						return gSessionManagerSessionPrompt.gSessionTreeData[idx].group;
						break;
					case "win_count":
						return gSessionManagerSessionPrompt.gSessionTreeData[idx].windows;
						break;
					case "tab_count":
						return gSessionManagerSessionPrompt.gSessionTreeData[idx].tabs;
						break;
				}
				return null;
			},
			canDrop: function(idx, orient)      { return false; },
			isContainer: function(idx)          { return false; },
			isContainerOpen: function(idx)      { return false; },
			isContainerEmpty: function(idx)     { return false; },
			isSelectable: function(idx, column) { return false; },
			isSeparator: function(idx)          { return false; },
			isSorted: function()                { return gSessionManagerSessionPrompt.sortedBy != 0; },
			isEditable: function(idx, column)   { return false; },
			getLevel: function(idx)             { return 0; },
			getParentIndex: function(idx)       { return -1; },
			getImageSrc: function(idx, column)  { return null; },

			hasNextSibling: function(idx, after) {
				return (idx <= after) && (idx < gSessionManagerSessionPrompt.gSessionTreeData.length - 1) && 
				       (after < gSessionManagerSessionPrompt.gSessionTreeData.length - 1);
			},

			getCellProperties: function(idx, column, prop) {
				if ((column.id == "group") && (gSessionManagerSessionPrompt.gSessionTreeData[idx].backup)) 
					prop.AppendElement(this._getAtom("disabled"));
				if (gSessionManagerSessionPrompt.gSessionTreeData[idx].latest) 
					prop.AppendElement(this._getAtom("latest"));
				if (gSessionManagerSessionPrompt.gSessionTreeData[idx].loaded)
					prop.AppendElement(this._getAtom("disabled"));
				if (gSessionManagerSessionPrompt.gSessionTreeData[idx].autosave)
					prop.AppendElement(this._getAtom(gSessionManagerSessionPrompt.gSessionTreeData[idx].autosave));
			},

			getRowProperties: function(idx, prop) {
				if (idx % 2 != 0)
					prop.AppendElement(this._getAtom("alternate"));
			},

			drop: function(row, orient) { },
			getCellValue: function(idx, column) { },
			getProgressMode : function(idx, column) { },
			toggleOpenState: function(idx) { },
			cycleHeader: function(column) { },
			cycleCell: function(idx, column) { },
			selectionChanged: function() { },
			setCellValue: function() { },
			setCellText: function() { },
			performAction: function(action) { },
			performActionOnCell: function(action, index, column) { },
			performActionOnRow: function(action, index) { },
			getColumnProperties: function(column, prop) { }
		},
	}
	window.addEventListener("load", gSessionManagerSessionPrompt.onLoad_proxy, false);
}

// String.trim is not defined in Firefox 3.0, so define it here if it isn't already defined.
if (typeof(String.trim) != "function") {
	String.prototype.trim = function() {
		return this.replace(/^\s+|\s+$/g, "");
	};
}
