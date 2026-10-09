//function to turn a time from seconds format to mm:ss format
var returnedSeconds, returnedMinutes;
export function calculateTime(secs){
	var minutes = Math.floor(secs/60);
	var seconds = Math.floor(secs%60);
	if (seconds<10)
		returnedSeconds =  "0" + seconds.toString();
	else 
		returnedSeconds = seconds.toString();
	if (minutes <10)
		returnedMinutes = "0" + minutes.toString();
	else 
		returnedMinutes = minutes.toString();
	return returnedMinutes + ":" + returnedSeconds;
}