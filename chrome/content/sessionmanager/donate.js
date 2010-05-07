var gSessionManagerDonate = {
	startup: function() {
		db_gExtensionsView = document.getElementById("extensionsView");
		db_gExtensionsView.addEventListener("select", gSessionManagerDonate.doIt, false);
	},

	doIt: function() {
		var myext = document.getElementById("urn:mozilla:item:{1280606b-2510-4fe0-97ef-9b5a22eafe30}");
		var db_donateContainer = document.getElementById("session_manager_donateContainer");
		var donateSpacer = document.getElementById("session_manager_donateSpacer");
		var nameVersionBox;
		
		try {
			nameVersionBox = document.getAnonymousElementByAttribute(myext, "anonid", "addonNameVersion");
			if(!nameVersionBox)
				nameVersionBox = document.getAnonymousElementByAttribute(myext, "class", "addon-name-version");
			
			// Only add link if not already there
			if (!nameVersionBox.getElementsByClassName("session_manager_donate").length) {
				var spacerClone = donateSpacer.cloneNode(true);
				spacerClone.hidden = false;
				nameVersionBox.appendChild(spacerClone);
				
				var containerClone = db_donateContainer.cloneNode(true);
				containerClone.hidden = false;
				nameVersionBox.appendChild(containerClone);
			}
		} catch (e) {}
	},

	link: function(url) {
		var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"].getService();
		var wmed = wm.QueryInterface(Components.interfaces.nsIWindowMediator);
		var win = wmed.getMostRecentWindow("navigator:browser");
		if (!win) {
			alert("Cannot open a new tab!");
		}
		else {
			var content = win.document.getElementById("content");
			content.selectedTab = content.addTab(url);	
		}
	}
}

window.addEventListener("load", gSessionManagerDonate.startup, true);

