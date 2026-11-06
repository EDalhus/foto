return {
	LrSdkVersion = 10.0,
	LrSdkMinimumVersion = 6.0,
	LrToolkitIdentifier = 'net.dalhus.foto',
	LrPluginName = 'Foto',
	LrPluginInfoUrl = 'https://foto.dalhus.net',
	LrPluginInfoProvider = 'FotoInfoProvider.lua',
	LrExportServiceProvider = {
		title = 'Foto',
		file = 'FotoServiceProvider.lua',
	},
	LrExportMenuItems = {
		{ title = 'Synkroniser med Foto …', file = 'FotoSyncMenu.lua' },
		{ title = 'Kopier album fra SmugMug …', file = 'FotoCopyMenu.lua' },
	},
	LrLibraryMenuItems = {
		{ title = 'Synkroniser med Foto …', file = 'FotoSyncMenu.lua' },
		{ title = 'Kopier album fra SmugMug …', file = 'FotoCopyMenu.lua' },
	},
	-- Holdes lik FotoAPI.VERSION.
	VERSION = { major = 0, minor = 4, revision = 0, build = 1 },
}
