#!/bin/node
"use strict"

const {program}=require("commander")
const rl=require("readline").createInterface({input: process.stdin, output: process.stdout})
rl.pause()
const fs=require("fs")
const qs=require("qs")
const axios=require("axios")
const FormData=require("form-data")
const path=require("path")
const cheerio=require("cheerio")

process.on('unhandledRejection', err => { // for convenience in debugging
  console.error(err)
  process.exit(1)
});

// load stored username/password
const storePath="/tmp/.opentrains-CLI-store"
let username, password, contestId, Sid
try{
	({username, password, contestId, Sid}=JSON.parse(fs.readFileSync(storePath)))
}catch(e){
	if(e.code!=="ENOENT")
		throw e
}

function readline(query){ return new Promise(
	//rl.resume()
	(resolve, _reject)=>rl.question(query, function(answer){
		rl.pause()
		resolve(answer)
	})
)}

async function login(options){
	if(options.username) username=options.username
	if(options.contestid) contestId=options.contestid
	if(options.password) password=options.password

	if(!username) throw Error("username is empty!")
	if(!contestId) throw Error("contestId is empty!")
	while(!password){
		password=await readline("Enter password: ")
	}

	if(!Sid){
		saveFile()
		const result=await axios.post(options.url, qs.stringify({
			contest_id: contestId, role: 0, login: username, password,
			locale_id: 0, // English
			submit: "Log in" // also posted by form, but likely accidentally
		}))
		Sid=result.request.path.match(/\?SID=(.+?)&/)[1]
	}
	saveFile()
}

function saveFile(){
	fs.writeFileSync(storePath, JSON.stringify({username, password, contestId, Sid}))
}

async function checkSession(f){
	// f: () -> axios response object
	// might call f twice if the session has expired

	const result=await f()
	const $=cheerio.load(result.data)
	if($("title").text()!=="Invalid session")
		return result

	await login()
	return await f()
}

function printSubmissions(data){ // data: HTML string
	const $=cheerio.load(data)
	for(const row of $("table.b1 tr").toArray().slice(1))
		console.log($(row).find("td").toArray().map(cell=>$(cell).text()))
}

async function listAllCommand(options){
	await login(options.parent)
	const result=await checkSession(async ()=>await axios.get(`${options.parent.url}?SID=${Sid}&all_runs=1&action=140`))
	// run id, time, size, problem, language, result, failed test, view source, view report
	printSubmissions(result.data)
}

async function submitCommand(problemIndex, languageIndex, fileName, options){
	await login(options.parent)

	if(!["2", "3", "5", "10", "13", "23", "63", "64", "66", "91"].includes(languageIndex))
		throw Error("Invalid languageIndex: "+languageIndex)

/*
option><option value="2">gcc - GNU C 6.4.0<
option><option value="3" selected="selected">g++ - GNU C++ 8.2 (c++17)<
option><option value="5">javac - Java JDK 1.8<
option><option value="10">javac-32 - Java JDK (32 bit) 1.8<
option><option value="13">python - Python 2.7.5<
option><option value="23">python3 - Python3 3.6.1<
option><option value="63">pypy - Python (PyPy) 2.7.13<
option><option value="64">pypy3 - Python3 (PyPy) 3.5.3<
option><option value="66">kotlin - Kotlin (kotlinc-jvm 1.1.3-2)<
option><option value="91">dmd - Unidentified DMD<
*/

	if(problemIndex!==parseInt(problemIndex).toString())
		throw Error("Invalid problemIndex: "+problemIndex)

	const form=new FormData() // multipart/form-data
	form.append("SID", Sid)
	form.append("prob_id", problemIndex) // 11 for example
	form.append("lang_id", languageIndex)
	form.append("file", 
		//fs.createReadStream(fileName),
		fs.readFileSync(fileName),
		path.basename(fileName))
	// fiddling with the API is difficult.
	// Something is wrong somewhere else too.
	// The file name could be a reason.
	form.append("action_40", "Send!") // perhaps unintentional?...
	const result=await checkSession(async ()=>await axios.post(`${options.parent.url}`, form.getBuffer(), {headers: form.getHeaders()}))
	printSubmissions(result.data)
}

program.version("0.0.0")
.option("-U, --url <url>", "url",
	"http://opentrains.mipt.ru/~ejudge/team.cgi"
	//"http://localhost/"
)
.option("-c, --contestid <contestid>", "contest id", "2708")
.option("-u, --username <username>", "username (login)", username)
.option("-p, --password <password>", "password", password)

program.command("list_all")
.alias("ls")
.alias("listall")
.alias("list-all")
.description("list all submissions")
.action(listAllCommand)

program.command("submit <problemindex> <languageindex> <filename>")
.alias("sub")
.description("submit")
.action(submitCommand)

program.parse(process.argv)
