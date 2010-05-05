const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;

// import logger function
Cu.import("resource://sessionmanager/modules/logger.jsm");

const HOSTNAME = "chrome://sessionmanager";
const USERNAME = "private-key-password";
const REALM = "Passphrase";

const LOGIN_MANAGER = Cc["@mozilla.org/login-manager;1"].getService(Ci.nsILoginManager);
const SECRET_DECODER_RING_SERVICE = Cc["@mozilla.org/security/sdr;1"].getService(Ci.nsISecretDecoderRing);

var EXPORTED_SYMBOLS = ["PasswordManager"];

var PasswordManager = {
	get password() 
	{
		let login = this.findPasswordLogin();
		return login ? login.password : null;
	},
	
	set password(aPassword)
	{
		let oldLogin = this.findPasswordLogin();
		let newLogin = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
		newLogin.init(HOSTNAME, null, REALM, USERNAME, aPassword, "", "");
		if (oldLogin) {
			LOGIN_MANAGER.modifyLogin(oldLogin, newLogin);
		}
		else {
			LOGIN_MANAGER.addLogin(newLogin);
		}
	},
	
	clearPassword: function()
	{
		let login = findPasswordLogin();
		if (login) LOGIN_MANAGER.removeLogin(login);
	},
	
	findPasswordLogin: function()
	{
		let logins = LOGIN_MANAGER.findLogins({}, HOSTNAME, null, REALM);
		for (let i = 0; i < logins.length; i++) {
			if (logins[i].username == USERNAME) {
				return logins[i];
				break;
			}
		}
	},

	// return TRUE if master password is set
	isMasterPasswordSet: function() 
	{
		let slot = Cc["@mozilla.org/security/pkcs11moduledb;1"].getService(Ci.nsIPKCS11ModuleDB).findSlotByName("");
		return (slot && (slot.status == Ci.nsIPKCS11Slot.SLOT_NOT_LOGGED_IN || slot.status == Ci.nsIPKCS11Slot.SLOT_LOGGED_IN));
	},

	// return TRUE if a user has set the firefox master password and has not yet logged in.
	isMasterPasswordRequired: function() 
	{
		let slot = Cc["@mozilla.org/security/pkcs11moduledb;1"].getService(Ci.nsIPKCS11ModuleDB).findSlotByName("");
		return (slot && slot.status == Ci.nsIPKCS11Slot.SLOT_NOT_LOGGED_IN);
	},
	
	enterMasterPassword: function() 
	{
		//encrypting a string should open the enter master password dialog if master password is set
		try {
			SECRET_DECODER_RING_SERVICE.encryptString("dummy");
			return true;
		}
		catch(ex) {
			return false;
		}
	}
};