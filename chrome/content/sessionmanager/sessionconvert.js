/*
 * This file contains conversion routines for converting from SessionSaver and TMP session formats to
 * Session Manager session format.  
 * Portions of the following code as marked were originally written by onemen, rue and pike
 */

/*
 * Code to convert from SessionSaver 0.2 format to Session Manager format
 * Original code by Morac except where indicated otherwise
 */
var gSessionSaverConverter = {
	
	sessionList: null,
	sessions: null,
	
	exportFileExt: "ssv", exportFileMask: "*.ssv",
	prefBranch:      'sessionsaver.',
	prefBranchStatic:      'static.', // all manually captured sessions
	prefBranchWindows:    'windows.', // the "live" capture of the current session
	staticBranchDefault:  'default.', // the default manual-session
	D : ["  ", "| "," |", " ||"], // new-style
	
	getEOL: function()
	{
		return /win|os[\/_]?2/i.test(navigator.platform)?"\r\n":/mac/i.test(navigator.platform)?"\r":"\n";
	},
	
	init: function() {
		this.prefService     = Components.classes['@mozilla.org/preferences-service;1'].getService(Components.interfaces.nsIPrefService);
		this.rootBranch         = this.prefService.getBranch(null);
		this.Branch             = this.prefService.getBranch(this.prefBranch);
		this.staticBranch       = this.prefService.getBranch(this.prefBranch + this.prefBranchStatic);
		this.windowBranch       = this.prefService.getBranch(this.prefBranch + this.prefBranchWindows);
		
		var windowMediator  = Components.classes['@mozilla.org/appshell/window-mediator;1'].getService(Components.interfaces.nsIWindowMediator);
		var chromeWin = windowMediator.getMostRecentWindow("navigator:browser");
		this.gSessionManager = chromeWin.gSessionManager;
			
		var aObj = {}, aObj2 = {}; 
		this.staticBranch.getChildList("", aObj);
		this.windowBranch.getChildList("", aObj2);
		
		if (aObj.value || aObj2.value) {
			var okay = true;
			var skip = false;
			if ((this.Branch.getPrefType("SM_Converted") == 128) && 
			     this.Branch.getBoolPref("SM_Converted")) {
				skip = true;
				if (this.confirm(this.gSessionManager._string("ss_convert_again"))) okay = false;
				
			}
			if (okay) {
				if (skip || !this.confirm(this.gSessionManager._string("ss_confirm_convert"))) {
					var data = this.createSessionData();
					this.findValidSession(data,true);
					this.Branch.setBoolPref("SM_Converted", true);
				}
			}
			
			// check if SessionSaver installed and if so don't offer to delete data
			if (!chromeWin.SessionSaver && !this.confirm(this.gSessionManager._string("ss_confirm_archive"))) {
				if (this.exportSession()) {
					try{ this.Branch.deleteBranch(""); } 
					catch(e) { this._prompt.alert(null,this.gSessionManager._string("sessionManager"), "Removed Fail: "+e); }
				}
			}
		}
		else {
			if (!this.confirm(this.gSessionManager._string("ss_confirm_import"))) this.importSession();
		}
		delete(this.prefService);
		delete(this.rootBranch);
		delete(this.Branch);
		delete(this.staticBranch);
		delete(this.windowBranch);
		delete(this.gSessionManager);
	},

	confirm: function (aMsg) {
		var promptService = this._prompt;
		return promptService.confirmEx(null,
									this.gSessionManager._string("sessionManager"),
									aMsg,
									(promptService.BUTTON_TITLE_YES * promptService.BUTTON_POS_0)
									+ (promptService.BUTTON_TITLE_NO * promptService.BUTTON_POS_1),
									null, null, null, null, {});
	},
	
	get _prompt() {
		return Components.classes["@mozilla.org/embedcomp/prompt-service;1"].getService(Components.interfaces.nsIPromptService);
	},
		
	get _sessions() {
		return gSessionSaverConverter.sessionList;
	},
	
	convertSession: function(client, zHash) {
		var i, j, m, SessionData = [], failedList = "\n";
		for (m in zHash.asName) {
			var name = zHash.asName[m];
			var zorder = client[m + ".zorder"].split(",");
			SessionData[name] = { cookies: (client[m + ".cookies"]?client[m + ".cookies"].split("  |"):null), windows:[] };
			for (i in zorder) {
				if (zorder[i] && client[(m + "." + zorder[i])]) SessionData[name].windows[i] = client[(m + "." + zorder[i])];
			}
		}
			
		this.sessionList = [];
		this.sessions = [];
		for (i in SessionData) {
			try {
				var windows = SessionData[i].windows;
				var totalTabCount = 0;
				var jsWindows = [];
			
				for (j in windows) {
					var session = windows[j].split(this.D[0]); // get stored window-session from data
					if (session.length < 8) return;   // bad session data since no tabs so exit
				
					var win = { tabs:[], width: session[1], height: session[2], screenX: session[3],
					            screenY: session[4], selected: parseInt(session[6] + 1), 
					            sizemode: ((session[9]=="1")?"maximized":"normal"), _closedTabs:[] };

					var chromeProperties = session[5].split("");
					var hidden = "";
					if (chromeProperties[0]=="0") win.hidden = win.hidden = "menubar"; 
					if (chromeProperties[1]=="0") win.hidden = win.hidden = ",toolbar"; 
					if (chromeProperties[2]=="0") win.hidden = win.hidden = ",locationbar";
					if (chromeProperties[3]=="0") win.hidden = win.hidden = ",personalbar";
					if (chromeProperties[4]=="0") win.hidden = win.hidden = ",statusbar"; 
					if (chromeProperties[5]=="0") win.hidden = win.hidden = ",scrollbars";
					if (hidden!="") win.hidden = hidden;
								
					var tabCount = parseInt(session[7]);
					totalTabCount = totalTabCount + tabCount;
					var sessionTabs = session[8].split(this.D[3]);;
				
					var tabs = win.tabs;
					for (var k=0; k < tabCount; k++) {
						var tabData = { entries: [], index: 0 };
						this.convertTab(sessionTabs[k], tabData);
						tabs.push(tabData);
					}
				
					jsWindows.push(win);
				}
				
				if (jsWindows.length) {
					var cookies = SessionData[i].cookies;
					if (cookies) {
						var jsCookies = { count:0 };
						for (j in cookies) {
							var cookie = cookies[j].match(/^([^ ]+) (.+)$/);
							if ((cookie && cookie[1] && cookie[2])) {
								jsCookies["domain" + ++jsCookies.count] = cookie[1];
								jsCookies["value" + jsCookies.count] = cookie[2];
							}
						}
						jsWindows[0].cookies = jsCookies;
					}
			
					this.sessions[i] = { windows: jsWindows, selectedWindow: 1 };
			
					var sessionListItem = { name: i, fileName: i, autosave: false, windows: jsWindows.length, tabs: totalTabCount }
					this.sessionList.push(sessionListItem);
				}
				else {
					failedList = failedList + "\n" + i;
				}
			}
			catch(ex) { 
				failedList = failedList + "\n" + i + " - " + ex;	
			}
		}
		
		if (failedList != "\n") {
			this._prompt.alert(null,this.gSessionManager._string("sessionManager"), this.gSessionManager._string("ss_failed")+failedList);
		}
		
		if (!this.sessionList.length) {
			this._prompt.alert(null, this.gSessionManager._string("sessionManager"), this.gSessionManager._string("ss_none"));
			return;
		}
		
		var sessions = this.gSessionManager.selectSession(this.gSessionManager._string("ss_select"), this.gSessionManager._string("ss_convert"), 
		                                                  { multiSelect: true }, function() { return gSessionSaverConverter.sessionList;});
		if (sessions) {
			sessions = sessions.split("\n");
			sessions.forEach(function (aSession) {
				var session = this.sessionList.filter(function(element,index,array) { return (element.name == aSession); });
				if (session.length) {
					var date = new Date();
					var aName = this.gSessionManager.getFormattedName("[ SessionSaver ] " + aSession, date);
					var file = this.gSessionManager.getSessionDir(this.gSessionManager.makeFileName(aName), true);
					var state = "[SessionManager]\nname=" + aName + "\ntimestamp=" + Date.now() + "\nautosave=false\tcount=" + 
					             session[0].windows + "/" + session[0].tabs + "\n" + uneval(this.sessions[aSession]);
					this.gSessionManager.writeFile(file, state);
				}
			}, this);
		
			this._prompt.alert(null,this.gSessionManager._string("sessionManager"),
			      ((sessions.length>1)?this.gSessionManager._string("ss_converted_many"):this.gSessionManager._string("ss_converted_one"))+":\n\n. . ."+sessions.join("\n. . ."));
		}
		delete(this.sessionList);
		delete(this.sessions);
	},
	
	knownProps: {x:0,p:0,q:0,f:0,a:0,i:0,s:0,z:0},
	contentTypeRe:   /^(Content-Type: )([^\r\n]+)((\r\n){1,2}|\r|\n)/m,  
	contentLengthRe: /^(Content-Length: )([^\r\n]+)((\r\n){1,2}|\r|\n)/m,
	
	convertTab: function(sessionTab, tabData) {
		// tab-properties
		var tabSession  = sessionTab.split(this.D[2]); // XXX (below) for tabs with nothing captured (eg. link->newtab failed) there's nothing to iterate, so we need to check 'tabSession[propPoint-1]' as a condition
		for (var propPoint=tabSession.length, propName;  tabSession[propPoint-1] && (propName=tabSession[propPoint-1].charAt(0));  propPoint--) if (propName=='z') break; else if (!propName in this.knownProps) tabSession.splice(propPoint++,1); // forwards-compatible, always
		var postData    = (tabSession[0].charAt(0) == "p") ? tabSession.shift().slice(1) : null; // post-data,        if any (nightly 26)
		var postDataII  = (tabSession[0].charAt(0) == "q") ? tabSession.shift().slice(1) : null; // post-data.ii,     if any (nightly 29)
		if (postDataII) postData = postDataII;
		var frameData   = (tabSession[0].charAt(0) == "f") ? tabSession.shift().slice(1) : null; // frame-data,     if any (nightly 27)
		var selectData  = (tabSession[0].charAt(0) == "s") ? tabSession.shift().slice(1) : null; // select-data,    if any (nightly 28)
		var inputData   = (tabSession[0].charAt(0) == "i") ? tabSession.shift().slice(1) : null; // input-data,     if any (nightly 28)
		var areaData    = (tabSession[0].charAt(0) == "a") ? tabSession.shift().slice(1) : null; // textarea-data,  if any (nightly 28)
		var propData    = (tabSession[0].charAt(0) == "x") ? tabSession.shift().slice(1) : null; // extra tab/docshell props, if any (nightly 29.iii)
		if (tabSession[0].charAt(0) != "z") tabSession.splice(0, 0, "z1.0"); // add text-zoom if not stored (history-string will be in slot[1])
		tabData.zoom    = parseFloat( tabSession[0].substr(1, tabSession.shift().length-1) ); // text-zoom (nightly 13)
		var activeIndex = parseInt( tabSession.shift() );
		tabData.index   = activeIndex + 1;
		var tabHistory  = tabSession/*.slice(0)*/; // the entire rest of our "session-array" is tab history

		var frameText = [];		
		for (var i=0; i < tabHistory.length; i++) {
			var history = tabHistory[i].split(this.D[1]);
			var entry = { url: history[1], scroll:history[0] };
			
			// active index - Session Saver does not postdata and frames for session history
			if (i == activeIndex) {
				// frames
				if (frameData) {
					entry.children = [];
					var frameData = frameData.split(':');
					var textKeys ={'i':"input",'a':"textarea"};
					for (var f = 0; f < frameData.length; f++) {
						frameData[f]=frameData[f].split(",");
						var url = unescape(frameData[f][0]);
						var id = unescape(frameData[f][3]);
						var name = (frameData[f].length>4)?unescape(frameData[f][4]):id;
						var scroll = parseInt(frameData[f][1]) + "," + parseInt(frameData[f][2]);
						var text = (frameData[f].length>5 && frameData[f][5]!='')?unescape(frameData[f][5]).split(" "):null;
						var postDataFrame = (frameData[f].length>6 && frameData[f][6]!='')?unescape(frameData[f][6]):null;						
						if (text && text.length>0) { 
							var t, key, textObj={}; 
							while ((t=text.shift())) key=textKeys[t.charAt(0)], textObj[key] = t.slice(1); 
							text = (textObj.input?textObj.input:"") + ((textObj.input && textObj.textarea)?":":"") + (textObj.textarea?textObj.textarea:""); 
							if (text) frameText.push(text);
						}
						
						var child = { url: url, scroll: scroll };
						if (postData) child.postData = postDataFrame;
						entry.children.push(child);
					}
				}
					
				// postdata
				if (postData) {
					entry.postdata = postData;             // Firefox 2 version
					//entry.postdata_b64 = btoa(postData);   // Firefox 3 version - FF3 can read FF2 version
				}
			}
			
			tabData.entries.push(entry);
		}
		
		var textData = "";
		if (areaData) areaData = areaData.split(":");
		if (inputData) {
			inputData = inputData.split(":");
			if (areaData) inputData = inputData.concat(areaData);
		}
		else inputData = areaData;
		if (inputData) {
			for (var i=0; i<inputData.length; i++) {
				var text = inputData[i].split(",,");
				if (text[0] && text[1]) textData = textData + ((textData)?" ":"") + text[1] + "=" + text[0];
			}
		}
		if (frameText) {
			// form text for frames is stored with parent but tagged with frame number
			for (var i=0; i<frameText.length; i++) {
				frameText[i] = frameText[i].split(":");
				for (var j=0; j<frameText[i].length; j++) {
					var text = frameText[i][j].split(",,");
					if (text[0] && text[1]) textData = textData + ((textData)?" ":"") + i + "|" + text[1] + "=" + text[0];
				}
			}			
		}
		if (textData) tabData.text = textData;
	},

	//
	// The following code comes from the SessionSaver 0.2d extension originally coded by rue and Pike
	// Modified by Morac to simplify and allow conversion to Session Manager format
	//
	
	/*
	 * The following functions allow importing of current Session Saver data in preferences
	 */
		
	importSession: function () {
		var fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(Components.interfaces.nsIFilePicker);
		var stream = Components.classes["@mozilla.org/network/file-input-stream;1"].createInstance(Components.interfaces.nsIFileInputStream);
		var streamIO = Components.classes["@mozilla.org/scriptableinputstream;1"].createInstance(Components.interfaces.nsIScriptableInputStream);
		var validFile = false;
			
		fp.init(window, "Select a File", fp.modeOpen);
		var ext = this.exportFileExt, mask = this.exportFileMask;
		fp.appendFilter("SessionSaver Session",mask);
		fp.defaultExtension = ext;
		
		if (fp.show() != fp.returnCancel) {
			stream.init(fp.file, 0x01, 0444, null);
			streamIO.init(stream);
			var data = streamIO.read(stream.available());
			streamIO.close(); stream.close();
			this.findValidSession(data, true);
		}
	},
	
	findValidSession: function(data, shouldConvert) {
		// convert and \r \r\n to \n so that we can handle new lines.  Note postdata will also be converted so 
		// we need to take that into account
		data = data.replace(/\r\n?/g, "\n");
		var resArrayAll = data.split("\n"), res, resultHash = {}, extraLines = "", lastHash;
		while ((res=resArrayAll.shift()) != null ) {
			var lineParse = res.match(/^([s|c|i|a|b] .+)   (.+)/m);
			if (lineParse) {
				resultHash[lineParse[1]] = lineParse[2];
				if (lastHash && extraLines) resultHash[lastHash] = resultHash[lastHash] + extraLines;
				extraLines = ""; 
				lastHash = lineParse[1];
			}
			else extraLines = extraLines + this.getEOL() + res;
		}
		var client={};
		var d =new Date(), curDate =(d.getMonth()+1)+"."+d.getDate()+"."+((d.getFullYear()+"").slice(2));
		var m;
		var s2Prefix=this.prefBranch+this.prefBranchStatic+"Main-Session_From_Archive_("+curDate+")."; // -> Main-Session From Archive (10.25.05)
		for (var n in resultHash) {
			var keyPair = n.match(/^([^ ]) ([^ ]+)/); if (!keyPair) {continue;} else var key=keyPair[1], name=keyPair[2];
			switch(key) {
				case "s": 
					if (name.indexOf(this.prefBranch + this.prefBranchWindows) == 0) {
						name = name.substring(this.prefBranch.length + this.prefBranchWindows.length);
					}
					client[s2Prefix+name] = resultHash[n]; 
					break;
				case "c": 
					client[name] = resultHash[n]; 
					break;   
			}
		}
		var zorderRe = /^(.*)\.zorder$/i, zei, zHash={asArray:[],asName:{}}; // [******. hehe -rue]
		for (m in client) {  
			if (zei=m.match(zorderRe)) { 
				var name=zei[1], mName = name.replace(this.prefBranch+this.prefBranchStatic,""); 
				var mName=mName.replace(/_/g," "); 
				zHash.asArray.push(mName),zHash.asName[name]=mName; 
			}   
		} 

		if (shouldConvert) {
			var sessionCnt = zHash.asArray.length;
			if (sessionCnt==0) return this._prompt.alert(this.gSessionManager._string("ss_none")); 
			this.convertSession(client,zHash);
		}
		
		return zHash;
	},

	/*
	 * The following functions allow exporting of current Session Saver data in preferences
	 */
	createSessionData: function() { // returns a single string, of the relevant prefs
		var d=new Date(),  curMonth=d.getMonth()+1,  curDate=(d.getMonth()+1)+"."+d.getDate()+"."+((d.getFullYear()+"").slice(2));
		var currName = this.prefBranch+this.prefBranchStatic+"default_("+curDate+")";
		var prefArrayAll = [];
		var prefConverter = { keyed:{}, hashed:{a:Components.interfaces.nsIPrefBranch.PREF_INT, b:Components.interfaces.nsIPrefBranch.PREF_BOOL, c:Components.interfaces.nsIPrefBranch.PREF_STRING}, retrieve:{a:"getIntPref",b:"getBoolPref",c:"getCharPref"} };
		var h = prefConverter.hashed; 
		for (var n in h) prefConverter.keyed[h[n]]=n; 
		var prefsToPush = ["sessionsaver.static.","sessionsaver.windows."];
		var push; 
		while ((push=prefsToPush.shift())) {
			var prefName, childArray = this.rootBranch.getChildList(push, {}); // array of pref-names, off this particular branch
			while ((prefName=childArray.shift())) {
				if (prefName.match(/^sessionsaver\.static\.sync_backup\./i)) {continue;}
				var key = prefConverter.keyed[ this.rootBranch.getPrefType(prefName) ];
				var getPrefAsType = prefConverter.retrieve[key];
				prefArrayAll.push((prefName.match(/^sessionsaver\.static/i)?key:"s")+" "+prefName+"   "+this.rootBranch[getPrefAsType](prefName)); }
		}
		return prefArrayAll.join("\n");
	},
		
	exportSession: function() {
		var d=new Date(),  curMonth=d.getMonth()+1,  curDate=(d.getMonth()+1)+"."+d.getDate()+"."+((d.getFullYear()+"").slice(2));
		var data = this.createSessionData();
		if (!data) {
			alert("There wasn't any Session Saver session-data to export!");
			return false;
		}
		var zHash = this.findValidSession(data,false);
		// make sure all newlines are set to OS default.
		data = data.replace(/\r\n?/g, "\n");
		data = data.replace(/\n/g, this.getEOL());
		var fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(Components.interfaces.nsIFilePicker);
		var filestream = Components.classes["@mozilla.org/network/file-output-stream;1"].createInstance(Components.interfaces.nsIFileOutputStream);
		var buffered   = Components.classes["@mozilla.org/network/buffered-output-stream;1"].createInstance(Components.interfaces.nsIBufferedOutputStream);
		var binstream  = Components.classes["@mozilla.org/binaryoutputstream;1"].createInstance(Components.interfaces.nsIBinaryOutputStream); 
		
		fp.init(window, "Select a File", fp.modeSave);
		var ext = this.exportFileExt, mask = this.exportFileMask;
		fp.appendFilter("SessionSaver Session",mask);
		fp.defaultExtension = ext;
		var sessionCnt  = zHash.asArray.length;
		var wordSpacer  = (curMonth >  9 && sessionCnt >  9) ? "":" ";
		var prefsTxt    = (curMonth < 10 && sessionCnt < 10) ? "+prefs":"+pref";
		if (sessionCnt > 1)
			var mainTxt = "("+sessionCnt+" sessions"+wordSpacer+prefsTxt+")"+" "+curDate; // "exports":"export" -> "sessions":"session"
		else
			mainTxt = zHash.asArray[0].slice(0,27); //31); //12)
		fp.defaultString  = mainTxt+"."+ext;
	
		if (fp.show() != fp.returnCancel) {
			if (fp.file.exists()) fp.file.remove(true);
			if (fp.file.exists()) {
				alert("The Export failed: try using a unique, or new, filename.");
				return false;
			}
			fp.file.create(fp.file.NORMAL_FILE_TYPE, 0666);
	
			filestream.init(fp.file, 0x02 | 0x08, 0644, 0);
			buffered.init(filestream, 64 * 1024);
			binstream.setOutputStream(buffered);
			binstream.writeBytes(data,data.length);
			binstream.close(), buffered.close();
			filestream.close(); 
		}
		return true;
	}
}

/********************************************************************************************************************
 *  Routines to convert from Tab Mix Plus session format to Session Manager format.
 *  Original code by Morac except where indicated otherwise
 ********************************************************************************************************************/

var gConvertTMPSession = {
	
	sessionList: null,
	isFirefox3: false,

	init: function() {
		this.RDFService = Components.classes["@mozilla.org/rdf/rdf-service;1"].getService(Components.interfaces.nsIRDFService);
		this.RDFResource = Components.interfaces.nsIRDFResource;
		
		var windowMediator  = Components.classes['@mozilla.org/appshell/window-mediator;1'].getService(Components.interfaces.nsIWindowMediator);
		var chromeWin = windowMediator.getMostRecentWindow("navigator:browser");
		this.gSessionManager = chromeWin.gSessionManager;
		
		// Determine Mozilla version to see what is supported
		try {
			var mAppVersion = Components.classes["@mozilla.org/xre/app-info;1"].
			                  getService(Components.interfaces.nsIXULAppInfo).platformVersion;
			this.isFirefox3 = (mAppVersion >= "1.9");
		} catch (ex) { dump(ex + "\n"); }
		
		if (!chromeWin.TMP_SessionStore) {
			this._prompt.alert(null, this.gSessionManager._string("sessionManager"), this.gSessionManager._string("tmp_no_install"));
			return;
		}
		else {
			this.SessionManager = chromeWin.SessionManager;
			this.convertSession = chromeWin.convertSession;
			this.gSessionPath = chromeWin.gSessionPath;
			if (!this.convertFile()) {
				if (!this.confirm(this.gSessionManager._string("tmp_no_default"))) {
					this.pickFile();
				}
			}
		}
	},
		
	//
	// The following code comes from the Tab Mix Plus extension originally coded by onemen
	// Modified by Morac to allow user to choose which sessions to convert
	// 
	// Note: These functions call Tab Mix Plus functions and as such are dependent on TMP
	//
	
	// Not currently used
	pickFile: function() {
		var file = null;
		const nsIFilePicker = Components.interfaces.nsIFilePicker;
		var fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
		fp.init(window, "Select session.rdf file to convert", nsIFilePicker.modeOpen);
		fp.defaultString="session.rdf";
		fp.appendFilter("RDF Files", "*.rdf");
		fp.appendFilter("Session Files", "*session*.*");
		fp.appendFilters(nsIFilePicker.filterText | nsIFilePicker.filterAll);

		if (fp.show() != nsIFilePicker.returnOK)
			return;

		file = fp.fileURL.spec;
		try {
			if (!this.convertFile(file)) {
				this._prompt.alert(null, this.gSessionManager._string("sessionManager"), this.gSessionManager._string("ss_none"));
			}
		} catch (ex) {
			dump(ex);
		}
	},
	
	get _prompt() {
		return Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
									 .getService(Components.interfaces.nsIPromptService);
	},

	confirm: function (aMsg) {
		var promptService = this._prompt;
		return promptService.confirmEx(null,
									this.gSessionManager._string("sessionManager"),
									aMsg,
									(promptService.BUTTON_TITLE_YES * promptService.BUTTON_POS_0)
									+ (promptService.BUTTON_TITLE_NO * promptService.BUTTON_POS_1),
									null, null, null, null, {});
	},
	
	convertFile: function (aFileUri) {
		var sessions;
		var tmpDATASource;
		if (aFileUri) {
			try {
				tmpDATASource = this.SessionManager.DATASource;
				this.SessionManager.DATASource = this.RDFService.GetDataSourceBlocking(aFileUri);
				sessions = this.SessionManager.getSessionList();
			} catch (e) { // corrupted session.rdf
				this.SessionManager.DATASource = tmpDATASource;
				dump(e);
			}
		}
		else
			sessions = this.SessionManager.getSessionList();

		var msg;
		if (!sessions) {
			if (tmpDATASource) this.SessionManager.DATASource = tmpDATASource;
			return false;
		}
		var rv = 0;
		if(this.SessionManager.nodeHasArc("rdf:gSessionManager", "status")) {
			rv = this.confirm(this.gSessionManager._string("ss_convert_again"));
		}
		else {
			this.SessionManager.setLiteral("rdf:gSessionManager", "status", "converted");
			this.SessionManager.saveStateDelayed();
		}
		if (rv == 0) {
			try {
				this.doConvert(sessions);
			}
			catch(ex) { dump(ex) };
		}

		if (tmpDATASource) this.SessionManager.DATASource = tmpDATASource;
			
		return true;
	},

	doConvert: function (sessions) {
		var sessionsPath = sessions.path.push(this.gSessionPath[3]);
		var sessionsName = sessions.list.push("Crashed Session");
		var _count = 0;
		
		this.sessionList = [];
		for (var i in sessions.list) {
			if (this.SessionManager.getLiteralValue(sessions.path[i], "nameExt")) {
				var sessionListItem = { name: unescape(sessions.list[i]), fileName: sessions.list[i] };
				this.sessionList.push(sessionListItem);
			}
		}
		var sessionsToConvert = this.gSessionManager.selectSession(this.gSessionManager._string("ss_select"), 
		                                                           this.gSessionManager._string("ss_convert"), 
		                                                           { multiSelect: true }, 
		                                                           function() { return gConvertTMPSession.sessionList;}
		                                                          );   
		delete this.sessionList;
		if (!sessionsToConvert) return;
		sessionsToConvert = sessionsToConvert.split("\n");
		var convert = [sessions.list.length];
		for (var i = 0; i < sessions.list.length; i++ ) {
			if (sessionsToConvert.indexOf(sessions.list[i]) != -1)
				convert[i] = true;
			else 
				convert[i] = false;
		}

		for (var i = 0; i < sessions.path.length; i++ ) {
			if (!convert[i]) continue;
			var sessionState = this.convertSession.getSessionState(sessions.path[i]);

			// get timestamp from nameExt property
			var dateString = "", fileDate;
			var nameExt = this.SessionManager.getLiteralValue(sessions.path[i], "nameExt");
			if (nameExt) {
				var date = nameExt.substr(nameExt.length - 20, 10);
				var time = nameExt.substr(nameExt.length - 9, 8);
				fileDate = " (" + date.split("/").join("-") + ")";
				dateString = " (" + date.split("/").join("-") + " " + time.substr(0, time.length - 3) + ")";
				var _time = time.split(":");
				var timestamp = new Date(date).valueOf() + 3600*_time[0] + 60*_time[1] + 1*_time[2];
			}
			var sessionName = unescape(sessions.list[i]);
			var name = "[ Tabmix ] " + sessionName + dateString;
			var fileName = this.gSessionManager.makeFileName("Tabmix - " + sessionName + fileDate);

			_count += this.save(sessionState, timestamp, name, fileName);
		}

		var msg;
		if (_count == 0) {
			this._prompt.alert(null, this.gSessionManager._string("sessionManager"), this.gSessionManager._string("tmp_unable"));
			return;
		}
		var msg = (_count > 1)?(_count + " " + this.gSessionManager._string("tmp_many")):this.gSessionManager._string("tmp_one");
		this._prompt.alert(null, this.gSessionManager._string("sessionManager"), msg);
	},
	
	save: function (aSession, aTimestamp, aName, aFileName) {
		if (aSession.windows.length == 0)
			return false;

		if (!aSession.session)
			aSession.session = { state:"stop" };
		var oState = "[SessionManager]\nname=" + aName + "\ntimestamp=" + aTimestamp + "\n" + uneval(aSession);
		var file = this.gSessionManager.getSessionDir(gSessionManager.makeFileName(aName));
		try {
			var file = this.gSessionManager.getSessionDir(aFileName, true);
			this.gSessionManager.writeFile(file, oState);
		}
		catch (ex) {
			dump(ex);
			return false;
		}
		return true;
	}
}
