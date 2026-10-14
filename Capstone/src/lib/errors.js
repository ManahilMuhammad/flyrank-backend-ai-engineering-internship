// error the express error handler will send to the client as is (expose = message safe to show)
export function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    err.expose = true;
    return err;
}
