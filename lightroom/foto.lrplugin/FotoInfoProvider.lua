--[[
	Seksjonen som vises for Foto under Fil → Behandle tilleggsprogrammer.
]]

local LrDialogs = import 'LrDialogs'
local LrFileUtils = import 'LrFileUtils'
local LrShell = import 'LrShell'
local LrView = import 'LrView'

local FotoAPI = require 'FotoAPI'
local Log = require 'FotoLog'

local function showLog()
	local path = Log.path()
	if path and LrFileUtils.exists(path) then
		LrShell.revealInShell(path)
	else
		LrDialogs.message('Ingen logg ennå', 'Loggfila lages første gang pluginen snakker med serveren.', 'info')
	end
end

return {
	sectionsForTopOfDialog = function(f, propertyTable)
		return {
			{
				title = 'Foto',
				f:row {
					f:static_text {
						title = 'Versjon ' .. FotoAPI.VERSION .. '. Publiser fra Lightroom til ditt eget Foto-nettsted.\n'
							.. 'Oppsett: Publiser tjenester → + → Gå til Administrasjon av publisering → Foto.\n'
							.. 'Kopier eksisterende album fra SmugMug: Fil → Ekstra pluginmoduler → Kopier album fra SmugMug.',
						fill_horizontal = 1,
						height_in_lines = 3,
					},
				},
				f:row {
					f:push_button { title = 'Vis loggfila', action = showLog },
					f:static_text { title = Log.path() or '', fill_horizontal = 1 },
				},
			},
		}
	end,
}
