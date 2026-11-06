--[[
	Fil (eller Bibliotek) → Ekstra pluginmoduler → Synkroniser med Foto …

	Henter mapper, album og bilder som er laget eller endret på nettstedet inn i Lightroom (se FotoSync.lua).
]]

local LrFunctionContext = import 'LrFunctionContext'
local LrTasks = import 'LrTasks'

local Sync = require 'FotoSync'

LrTasks.startAsyncTask(function()
	LrFunctionContext.callWithContext('Foto: synkroniser', Sync.run)
end)
