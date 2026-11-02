--[[
	Loggfil for feilsøking.
	Mac: ~/Library/Logs/Foto-Lightroom.log   Windows: Dokumenter\Foto-Lightroom.log
	API-nøkkelen skrives aldri til loggen. Fila roteres ved ca. 1 MB (forrige ligger i .1).
]]

local LrPathUtils = import 'LrPathUtils'
local LrDate = import 'LrDate'

local Log = {}

local MAX_BYTES = 1024 * 1024
local cachedPath
local writes = 0

function Log.path()
	if cachedPath == nil then
		local ok, p = pcall(function()
			if MAC_ENV then
				local home = LrPathUtils.getStandardFilePath('home')
				return LrPathUtils.child(LrPathUtils.child(LrPathUtils.child(home, 'Library'), 'Logs'), 'Foto-Lightroom.log')
			end
			return LrPathUtils.child(LrPathUtils.getStandardFilePath('documents'), 'Foto-Lightroom.log')
		end)
		cachedPath = (ok and type(p) == 'string' and p ~= '') and p or false
	end
	return cachedPath or nil
end

local function rotateIfLarge(path)
	local f = io.open(path, 'r')
	if not f then return end
	local size = f:seek('end')
	f:close()
	if size and size > MAX_BYTES then
		os.remove(path .. '.1')
		os.rename(path, path .. '.1')
	end
end

local function timestamp()
	local ok, s = pcall(function() return LrDate.timeToUserFormat(LrDate.currentTime(), '%Y-%m-%d %H:%M:%S') end)
	return ok and s or os.date('%Y-%m-%d %H:%M:%S')
end

local function write(level, ...)
	local parts = {}
	for i = 1, select('#', ...) do
		parts[#parts + 1] = tostring((select(i, ...)))
	end
	local line = timestamp() .. ' ' .. level .. ' ' .. table.concat(parts, ' '):gsub('[\r\n]+', ' ⏎ ') .. '\n'
	pcall(function()
		local path = Log.path()
		if not path then return end
		writes = writes + 1
		if writes % 50 == 1 then rotateIfLarge(path) end
		local f = io.open(path, 'a')
		if f then
			f:write(line)
			f:close()
		end
	end)
end

function Log.info(...) write('INFO', ...) end
function Log.warn(...) write('ADVARSEL', ...) end
function Log.error(...) write('FEIL', ...) end

return Log
